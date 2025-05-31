const WebSocket = require("ws");
const config = require("../config");
const state = require("../state");
const utils = require("../utils/index");
const sessionManager = require("../session/manager");
const resourceManager = require("../services/resourceManager");
const dashboardService = require("../services/dashboardService");
const apiClient = require("./apiClient");
const pty = require('node-pty');

let wssInstance = null;

/**
 * Initializes the WebSocket server and attaches event listeners.
 * @param {http.Server} server - The HTTP server instance.
 */
function initializeWebSocketServer(server) {
  if (wssInstance) {
    console.warn("[WebSocket] WebSocket server already initialized.");
    return;
  }

  wssInstance = new WebSocket.Server({ server });
  console.log(`[WebSocket] WebSocket server listening on port ${config.PORT}`);

  wssInstance.on("connection", (ws, req) => {
    const connIp = req.socket.remoteAddress || req.headers['x-forwarded-for'];
    console.log(`[WebSocket] New connection from ${connIp}`);

    // Setup heartbeat
    ws.internalId = utils.generateId("ws-temp");
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    let connectionType = "unknown";
    let connectionId = null;

    ws.on("message", async rawMsg => {
      ws.isAlive = true;
      let data, isJson = false;
      try {
        data = JSON.parse(rawMsg.toString());
        isJson = true;
      } catch {
        data = rawMsg;
      }

      // --- Initial routing ---
      if (connectionType === "unknown") {
        // Contributor registration
        if (isJson && data.type === "register_contributor" && data.nodeId) {
          connectionType = "contributor";
          connectionId = data.nodeId;
          ws.internalId = connectionId;
          console.log(`[WebSocket] Contributor ${connectionId} registering.`);
          const existing = state.contributorNodes.get(connectionId);
          if (existing?.ws && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
            existing.ws.terminate();
          }
          const nodeInfo = {
            ws,
            id: connectionId,
            address: data.providerAddress || null,
            ram: data.totalRam || "0Mi",
            cpu: data.totalCpu || "0m",
            storage: data.totalStorage || "0Gi",
            availableRam: data.availableRam || data.totalRam || "0Mi",
            availableCpu: data.availableCpu || data.totalCpu || "0m",
            activeTerminals: existing?.activeTerminals || new Set(),
            lastSeen: Date.now(),
            isAlive: true
          };
          state.contributorNodes.set(connectionId, nodeInfo);
          ws.send(JSON.stringify({ type: "ack_register", status: "success", nodeId: connectionId }));
          dashboardService.broadcastDashboardUpdate();
          return;
        }

        // Reattach existing client session
        if (isJson && data.type === "request_terminal" && data.subscriptionId && state.clientSessions.has(data.subscriptionId)) {
          connectionType = "client";
          connectionId = data.subscriptionId;
          ws.internalId = connectionId;
          console.log(`[WebSocket] Reattaching session ${connectionId}`);
          const session = state.clientSessions.get(connectionId);
          session.ws = ws;
          session.status = "active";
          ws.send(JSON.stringify({ type: "ack_request", status: "active", message: "Reattached to session." }));
          dashboardService.broadcastDashboardUpdate();

          // Only reattach if PTY alive
          const proc = session.ptyProcess;
          if (proc && !proc.killed) {
            setupPtyListeners(proc, connectionId);
          } else {
            console.error(`[WebSocket] Cannot reattach PTY for ${connectionId}: invalid or killed.`);
            sessionManager.cleanupClientSession(connectionId, "PTY invalid on reattach");
          }
          return;
        }

        // New client terminal request
        if (isJson && data.type === "request_terminal" && data.userAddress && data.username) {
          // prevent duplicate
          for (const s of state.clientSessions.values()) {
            if (s.userAddress === data.userAddress && s.username === data.username && !["failed","closed"].includes(s.status)) {
              ws.send(JSON.stringify({ type: "error", status: "failed", message: "Active session exists." }));
              ws.close(1008, "Duplicate session");
              return;
            }
          }
          connectionType = "client";
          connectionId = utils.generateId("client");
          ws.internalId = connectionId;
          console.log(`[WebSocket] New client ${connectionId}`);
          const session = {
            id: connectionId,
            ws,
            status: "verifying",
            ptyProcess: null,
            podName: null,
            contributorId: null,
            userAddress: data.userAddress,
            username: data.username,
            password: data.password,
            requestedRamMi: data.requestedRamMi || 100,
            requestedCpuM: data.requestedCpuM || 100,
            backupInProgress: false,
            backupInfo: null,
            recoveryAttempt: 0,
            isAlive: true
          };
          state.clientSessions.set(connectionId, session);
          ws.send(JSON.stringify({ type: "ack_request", status: "verifying", message: "Verifying access..." }));
          dashboardService.broadcastDashboardUpdate();

          try {
            const verificationResult = await apiClient.verifyAccessAndGetActiveNode(
              data.userAddress, data.username, data.password
            );
            await sessionManager.handleVerificationResult(connectionId, verificationResult);
            const cur = state.clientSessions.get(connectionId);
            if (cur?.status === 'active' && cur.ptyProcess) {
              setupPtyListeners(cur.ptyProcess, connectionId);
            } else {
              console.error(`[WebSocket] Session ${connectionId} not active after verify.`);
              sessionManager.cleanupClientSession(connectionId, "Allocation inconsistent");
            }
          } catch (err) {
            console.error(`[WebSocket] Verification flow error for ${connectionId}: ${err.message}`);
          }
          return;
        }

        // Dashboard registration
        if (isJson && data.type === "request_dashboard_updates") {
          connectionType = "dashboard";
          connectionId = utils.generateId("dash");
          ws.internalId = connectionId;
          state.dashboardSockets.set(connectionId, { ws, id: connectionId, isAlive: true });
          const stateInfo = dashboardService.getSystemState();
          ws.send(JSON.stringify({ type: "dashboard_update", state: stateInfo }));
          return;
        }

        // Invalid initial
        ws.close(1003, "Invalid initial message");
        return;
      }

      // --- Subsequent messages ---
      const sessId = ws.internalId;
      if (connectionType === "client" && sessId) {
        const session = state.clientSessions.get(sessId);
        if (session?.status === 'active' && session.ptyProcess && !session.ptyProcess.killed) {
          if (isJson && data.type === 'resize') {
            session.ptyProcess.resize(data.cols, data.rows);
          } else if (!isJson) {
            session.ptyProcess.write(data);
          }
        }
      }
      // contributor/dashboard handlers omitted for brevity...
    });

    ws.on("close", (code, reason) => {
      const id = ws.internalId;
      console.log(`[WebSocket] Connection closed for ${id} (type=${connectionType}) code=${code}`);
      ws.isAlive = false;
      if (connectionType === 'client' && state.clientSessions.has(id)) {
        const session = state.clientSessions.get(id);
        session.status = 'detached';
        session.ws = null;
        dashboardService.broadcastDashboardUpdate();
      }
      // contributor/dashboard cleanup omitted...
    });

    ws.on("error", err => {
      console.error(`[WebSocket] Error on ${ws.internalId}: ${err.message}`);
      ws.terminate();
    });
  });
}

/**
 * Sets up listeners for a PTY process, preventing duplicates and dead attaches.
 * @param {pty.IPty} ptyProcess
 * @param {string} clientId
 */
function setupPtyListeners(ptyProcess, clientId) {
  const session = state.clientSessions.get(clientId);
  if (!session || session.ptyProcess !== ptyProcess || !ptyProcess || ptyProcess.killed) {
    console.error(`[WebSocket][PTY] Abort listener setup for ${clientId}: invalid or killed.`);
    if (ptyProcess && !ptyProcess.killed) ptyProcess.kill();
    return;
  }

  // Prevent duplicate listeners
  if (ptyProcess._listenersAttached) {
    console.warn(`[WebSocket][PTY] Listeners already attached for PID=${ptyProcess.pid}. Skipping.`);
    return;
  }
  ptyProcess._listenersAttached = true;

  console.log(`[WebSocket][PTY] Attaching listeners for PID=${ptyProcess.pid} on ${clientId}`);
  let closed = false;

  ptyProcess.onData(data => {
    if (closed) return;
    const cur = state.clientSessions.get(clientId);
    if (cur?.ws?.readyState === WebSocket.OPEN) {
      cur.ws.send(data);
    } else {
      closed = true;
      ptyProcess.kill();
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (closed) return;
    closed = true;
    console.log(`[WebSocket][PTY] PTY PID=${ptyProcess.pid} exited code=${exitCode}`);
    sessionManager.cleanupClientSession(clientId, `PTY exited (code=${exitCode})`);
  });
}

module.exports = { initializeWebSocketServer };

