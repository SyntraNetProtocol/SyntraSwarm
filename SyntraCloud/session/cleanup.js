// sessionCleanup.js
const WebSocket = require("ws");
const fsp = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const config = require("../config");
const state = require("../state");
const resourceManager = require("../services/resourceManager");
const dashboardService = require("../services/dashboardService");

/**
 * Sends an error message to the client's WebSocket and initiates session cleanup.
 * @param {string} clientId - The ID of the client session.
 * @param {string} errorMessage - The error message to send.
 * @param {number} [closeCode=1011] - WebSocket close code. Use 0 to not close WS.
 * @param {string} [closeReason="Internal Server Error"] - WebSocket close reason.
 */
function sendErrorAndCleanup(clientId, errorMessage, closeCode = 1011, closeReason = "Internal Server Error") {
  const session = state.clientSessions.get(clientId);
  const cleanErrorMessage = errorMessage.replace(/\x1b\[[0-9;]*m/g, ''); // Remove ANSI codes

  if (session?.ws?.readyState === WebSocket.OPEN) {
    try {
      session.ws.send(JSON.stringify({ type: "error", status: "failed", message: cleanErrorMessage }));
      if (closeCode !== 0) {
        console.log(`[SessionCleanup] Closing WebSocket for ${clientId} with code ${closeCode}: ${closeReason}`);
        session.ws.close(closeCode, closeReason.substring(0, 50));
      }
    } catch (e) {
      console.error(`[SessionCleanup] Error sending error/closing WebSocket for ${clientId}:`, e.message);
      if (closeCode !== 0 && session.ws.readyState === WebSocket.OPEN) {
        try {
          console.log(`[SessionCleanup] Terminating WebSocket for ${clientId} due to send/close error.`);
          session.ws.terminate();
        } catch (termErr) { /* Ignore */ }
      }
    }
  } else if (closeCode !== 0) {
    console.log(`[SessionCleanup] WebSocket for ${clientId} already closed or missing. Cannot send error.`);
  }

  if (closeCode !== 0) {
    console.log(`[SessionCleanup] Initiating cleanup for session ${clientId} due to error: ${closeReason}`);
    cleanupClientSession(clientId, `${closeReason}: ${cleanErrorMessage.substring(0, 100)}`);
  } else {
    console.log(`[SessionCleanup] Error reported for ${clientId} but WebSocket connection kept open.`);
    if(session) session.status = 'failed'; // Mark status as failed if not closing
    dashboardService.broadcastDashboardUpdate();
  }
}

/**
 * Cleans up all resources associated with a client session.
 * Kills PTY, deletes Pod, releases contributor resources, removes session state, closes WS.
 * @param {string} clientId - The ID of the client session to clean up.
 * @param {string} [reason="No reason specified"] - Reason for cleanup (for logging).
 */
function cleanupClientSession(clientId, reason = "No reason specified") {
  console.log(`[SessionCleanup] Cleaning up session ${clientId}. Reason: ${reason}`);
  const session = state.clientSessions.get(clientId);

  if (!session) {
    console.warn(`[SessionCleanup] Cleanup: Session ${clientId} already removed.`);
    return;
  }

  state.clientSessions.delete(clientId);
  console.log(`[SessionCleanup] Session ${clientId} removed from active sessions map.`);
  dashboardService.broadcastDashboardUpdate();

  const { ptyProcess, podName, contributorId, requestedRamMi, requestedCpuM, ws } = session;
  console.log(`[SessionCleanup] Cleanup details for ${clientId}: Pod=${podName || 'N/A'}, Node=${contributorId || 'N/A'}, PTY=${ptyProcess ? 'Yes' : 'No'}, WS=${ws ? ws.readyState : 'N/A'}`);

  // 1. Kill PTY Process
  if (ptyProcess && !ptyProcess.killed) {
    console.log(`[SessionCleanup] Cleanup ${clientId}: Killing PTY process (PID: ${ptyProcess.pid})...`);
    try { ptyProcess.kill(); } catch (e) { console.error(`[SessionCleanup] Cleanup ${clientId}: Error killing PTY process: ${e.message}`); }
  }

  // 2. Delete Kubernetes Pod
  if (podName) {
    console.log(`[SessionCleanup] Cleanup ${clientId}: Deleting pod ${podName} (ignore-not-found)...`);
    exec(`kubectl delete pod ${podName} -n ${config.K8S_NAMESPACE} --ignore-not-found=true --now --wait=false`,
      (err, stdout, stderr) => {
        if (err) console.error(`[SessionCleanup] Cleanup ${clientId}: Error deleting pod ${podName}: ${stderr || err.message}`);
      }
    );
  }

  // 3. Release Resources on Contributor Node
  if (contributorId && state.contributorNodes.has(contributorId)) {
    const node = state.contributorNodes.get(contributorId);
    if (node.activeTerminals?.has(clientId)) {
      console.log(`[SessionCleanup] Cleanup ${clientId}: Releasing resources (${requestedRamMi || 0}Mi/${requestedCpuM || 0}m) on node ${contributorId}...`);
      resourceManager.releaseResources(contributorId, clientId, requestedRamMi || 0, requestedCpuM || 0);
      dashboardService.broadcastDashboardUpdate();
    } else {
      console.warn(`[SessionCleanup] Cleanup ${clientId}: Node ${contributorId} found, but client not in its active terminals list.`);
    }
  } else if (contributorId) {
    console.warn(`[SessionCleanup] Cleanup ${clientId}: Contributor node ${contributorId} not found. Cannot release resources.`);
  }

  // 4. Close WebSocket Connection
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log(`[SessionCleanup] Cleanup ${clientId}: Closing WebSocket connection (Code: 1000)...`);
    try { ws.close(1000, `Session cleanup: ${reason.substring(0, 50)}`); }
    catch (e) { console.warn(`[SessionCleanup] Cleanup ${clientId}: Error closing WebSocket: ${e.message}. Terminating.`); try { ws.terminate(); } catch (termErr) { /* Ignore */ } }
  }

  // 5. Clean up temporary files
  console.log(`[SessionCleanup] Cleanup ${clientId}: Checking for temporary files in ${config.TEMP_BACKUP_DIR}...`);
  fsp.readdir(config.TEMP_BACKUP_DIR)
    .then(files => {
      const clientFiles = files.filter(f => f.includes(clientId) || (podName && f.includes(podName)));
      if (clientFiles.length > 0) {
        console.log(`[SessionCleanup] Cleanup ${clientId}: Found ${clientFiles.length} temp file(s) to delete.`);
        clientFiles.forEach(f => {
          const filePath = path.join(config.TEMP_BACKUP_DIR, f);
          fsp.unlink(filePath).catch(err => { if (err.code !== 'ENOENT') console.error(`[SessionCleanup] Cleanup ${clientId}: Error deleting temp file ${filePath}: ${err.message}`); });
        });
      }
    })
    .catch(err => { if (err.code !== 'ENOENT') console.error(`[SessionCleanup] Cleanup ${clientId}: Error reading temp backup directory: ${err.message}`); });

  console.log(`[SessionCleanup] Cleanup finished for session ${clientId}.`);
}

module.exports = {
  sendErrorAndCleanup,
  cleanupClientSession,
};

// Note: sessionLifecycle.js imports functions from this file.
// Note: sessionRecovery.js will also import functions from this file.