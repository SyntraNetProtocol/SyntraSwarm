// dashboardService.js
const WebSocket = require("ws");
const state = require("../state/index");
const { parseResourceValue } = require("../utils/index");

/**
 * Gathers the current state of contributors and clients for the dashboard.
 * @returns {object} Object containing { summary, contributors, clients }
 */
function getSystemState() {
  const now = Date.now();

  // --- Contributors State ---
  const contributors = Array.from(state.contributorNodes.entries()).map(([id, node]) => {
     const isConnected = node.ws?.readyState === WebSocket.OPEN;
     const isAlive = node.isAlive ?? false; // Use nullish coalescing for default
     return {
      id: id,
      connected: isConnected,
      isAlive: isAlive, // Reflects ping/pong status
      address: node.address || "N/A", // Provider address if available
      totalRam: node.ram || "0Mi",
      totalCpu: node.cpu || "0m",
      totalStorage: node.storage || "N/A",
      // Report available only if connected and alive
      availableRam: (isConnected && isAlive) ? (node.availableRam || "0Mi") : "N/A",
      availableCpu: (isConnected && isAlive) ? (node.availableCpu || "0m") : "N/A",
      activeTerminalsCount: node.activeTerminals?.size || 0,
      activeTerminalIds: node.activeTerminals ? Array.from(node.activeTerminals) : [],
      lastSeen: node.lastSeen || null, // Timestamp of last message/ping
      lastSeenAgo: node.lastSeen ? `${Math.round((now - node.lastSeen) / 1000)}s ago` : "Never",
    };
  });

  // --- Clients State ---
  const clients = Array.from(state.clientSessions.entries()).map(([id, session]) => {
    const isConnected = session.ws?.readyState === WebSocket.OPEN;
     const isAlive = session.isAlive ?? false;
    const backupInfo = session.backupInfo || {}; // Ensure backupInfo exists
    return {
      id: id,
      connected: isConnected,
       isAlive: isAlive,
      status: session.status || "unknown",
      userAddress: session.userAddress || "N/A",
      username: session.username || "N/A", // Be careful about exposing usernames if sensitive
      contributorId: session.contributorId || "N/A",
      podName: session.podName || "N/A",
      ptyExists: !!session.ptyProcess,
      ptyAlive: session.ptyProcess ? !session.ptyProcess.killed : false, // Check if PTY process exists and isn't killed
      requestedRamMi: session.requestedRamMi || 0,
      requestedCpuM: session.requestedCpuM || 0,
      backupInProgress: session.backupInProgress || false,
      lastBackupCid: backupInfo.lastBackupCid || "N/A",
      lastBackupTimestamp: backupInfo.timestamp || null,
      lastBackupTimestampStr: backupInfo.timestamp ? new Date(backupInfo.timestamp).toLocaleString() : "N/A",
      recoveryAttempt: session.recoveryAttempt || 0,
      activeNodeId: session.activeNodeId || "N/A", // From DLT verification
    };
  });

  // --- Summary Calculation ---
  let totalAdvertisedRamMi = 0;
  let totalAdvertisedCpuM = 0;
  let totalAvailableRamMi = 0;
  let totalAvailableCpuM = 0;
  let totalAdvertisedStorageGi = 0; // Assuming GiB for storage from registration
  let connectedContributorCount = 0;

  contributors.forEach(c => {
    // Calculate totals only for contributors considered active and healthy
    if (c.connected && c.isAlive) {
      connectedContributorCount++;
      totalAdvertisedRamMi += parseResourceValue(c.totalRam);
      totalAdvertisedCpuM += parseResourceValue(c.totalCpu);
      totalAdvertisedStorageGi += parseResourceValue(c.totalStorage); // Use GiB parser if different
      totalAvailableRamMi += parseResourceValue(c.availableRam); // Will be 0 if N/A
      totalAvailableCpuM += parseResourceValue(c.availableCpu); // Will be 0 if N/A
    }
  });

  // Calculate connected clients based on WebSocket and liveness
   const connectedClientCount = clients.filter(c => c.connected && c.isAlive).length;

  const summary = {
    totalContributors: state.contributorNodes.size,
    connectedContributors: connectedContributorCount,
    totalClients: state.clientSessions.size,
    connectedClients: connectedClientCount, // Count clients with open+alive WS
    totalAdvertisedRamMi,
    totalAdvertisedCpuM,
    totalAdvertisedStorageGi, // Ensure units are consistent or clearly labeled
    totalAvailableRamMi,
    totalAvailableCpuM,
    timestamp: now,
  };

  return { summary, contributors, clients };
}

/**
 * Broadcasts the current system state to all connected dashboard clients.
 * Handles potential errors during sending and removes disconnected clients.
 */
function broadcastDashboardUpdate() {
  if (state.dashboardSockets.size === 0) {
    // console.log("[Dashboard] No dashboard clients connected, skipping broadcast.");
    return;
  }

  try {
    const systemState = getSystemState();
    const stateJson = JSON.stringify({ type: "dashboard_update", state: systemState });

    // console.log(`[Dashboard] Broadcasting update to ${state.dashboardSockets.size} dashboard client(s).`);
    state.dashboardSockets.forEach((wsInfo, dashboardId) => {
      if (wsInfo.ws.readyState === WebSocket.OPEN) {
        wsInfo.ws.send(stateJson, (err) => {
          if (err) {
             console.error(`[Dashboard] Error sending update to dashboard ${dashboardId}: ${err.message}. Terminating connection.`);
            // Terminate on send error, close event will handle removal from map
            wsInfo.ws.terminate();
            // No need to delete here, 'close' event handler in websocketHandler will do it
          }
        });
      } else {
        // WebSocket is not open (CLOSING, CLOSED), should be removed.
        // The 'close' event handler is the primary place for removal.
        // console.log(`[Dashboard] Found non-open WebSocket for dashboard ${dashboardId} during broadcast (State: ${wsInfo.ws.readyState}). Will be removed on close.`);
        // Avoid modifying the map while iterating if possible, let close handler do it.
      }
    });
  } catch (error) {
     console.error("[Dashboard] Error generating or broadcasting dashboard update:", error);
  }
}

module.exports = {
  getSystemState,
  broadcastDashboardUpdate,
};