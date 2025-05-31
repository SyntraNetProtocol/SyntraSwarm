// sessionRecovery.js
const WebSocket = require("ws"); // To check WebSocket state and send messages
const path = require("path");
const { exec } = require("child_process");
const config = require("../config");
const state = require("../state");
const apiClient = require("../network/apiClient");
const resourceManager = require("../services/resourceManager");
const k8sUtils = require("../infra/kubernetes/utils");
const ipfsService = require("../services/ipfsService");
const encryption = require("../utils/encryption");
const utils = require("../utils/index");
const dashboardService = require("../services/dashboardService");
// Import necessary functions from other session modules
const { sendErrorAndCleanup } = require("./cleanup");
const { triggerBackup } = require("./backup"); // To schedule backup after recovery

/**
 * Initiates the automatic recovery process for a client session after a contributor node failure.
 * Fetches backup, finds new node, allocates, spawns pod, restores backup, starts PTY.
 * Includes retry logic.
 * @param {string} clientId - The ID of the client session needing recovery.
 * @param {string} failedNodeId - The ID of the contributor node that failed.
 * @returns {Promise<void>}
 */
async function initiateRecovery(clientId, failedNodeId) {
  let session = state.clientSessions.get(clientId);

  // --- Pre-checks ---
  if (!session) { console.warn(`[SessionRecovery] Aborted: Session ${clientId} not found.`); return; }
  if (session.status === "recovering" || session.status === "pending_recovery") { console.log(`[SessionRecovery] Already recovering/pending for ${clientId}. Ignoring.`); return; }
  if (session.status === "closed" || session.status === "failed") { console.log(`[SessionRecovery] Aborted: Session ${clientId} already ${session.status}.`); return; }

  // --- DLT Credential Check (Workaround) ---
  // PROBLEM: Password likely deleted. Need it for DLT fetch.
  // TODO: Implement token-based auth or alternative secure credential handling.
  if (!session.username || !session.password) {
    console.error(`[SessionRecovery] FATAL for ${clientId}: Missing auth credentials (password). Cannot fetch backup from DLT.`);
    sendErrorAndCleanup(clientId, "Recovery failed: Missing authentication credentials for backup retrieval.", 1011, "Recovery Auth Failed");
    return;
  }

  // --- Retry Limit Check ---
  const currentAttempt = (session.recoveryAttempt || 0) + 1;
  if (currentAttempt > 3) {
    console.error(`[SessionRecovery] Permanent failure for ${clientId} after ${session.recoveryAttempt} attempts.`);
    sendErrorAndCleanup(clientId, "Automatic recovery failed after multiple attempts.", 1011, "Recovery Failed Permanently");
    return;
  }

  // --- Start Recovery Attempt ---
  console.log(`[SessionRecovery] Initiating recovery for ${clientId} from failed node ${failedNodeId}. Attempt: ${currentAttempt}`);
  session.status = "recovering";
  session.recoveryAttempt = currentAttempt;
  dashboardService.broadcastDashboardUpdate();

  // Store essential info and clean session state
  const oldPty = session.ptyProcess;
  const oldPodName = session.podName;
  const originalUsername = session.username;
  const originalPassword = session.password; // Keep WORKAROUND password
  const requestedRamMi = session.requestedRamMi || 100;
  const requestedCpuM = session.requestedCpuM || 100;
  session.ptyProcess = null;
  session.podName = null;
  session.contributorId = null;
  if (oldPty && !oldPty.killed) { try { oldPty.kill(); } catch (e) { /* Ignore */ } }

  // --- Recovery Steps ---
  let newContributorId = null;
  let newPodName = null;
  let downloadedEncryptedPath = null;
  let decryptedBackupPath = null;
  let fileAesKey = null;

  try {
    // 1. Fetch Latest Backup Info from DLT
    console.log(`[SessionRecovery] ${clientId}: Step 1 - Fetching backup info...`);
    const backupInfo = await apiClient.getLatestBackupInfoFromDlt(clientId, originalUsername, originalPassword);
    if (!backupInfo?.cid || !backupInfo?.encryptedAesKeyHex) {
      throw new Error("No valid backup metadata found on DLT.");
    }
    const { cid, encryptedAesKeyHex } = backupInfo;
    console.log(`[SessionRecovery] ${clientId}: Found backup CID ${cid.substring(0,10)}...`);

    // 2. Decrypt Backup File Key
    console.log(`[SessionRecovery] ${clientId}: Step 2 - Decrypting backup key...`);
    try { fileAesKey = encryption.decryptWithMasterKey(encryptedAesKeyHex); }
    catch (decryptionError) { throw new Error(`Cannot decrypt backup key: ${decryptionError.message}`); }

    // 3. Find New Contributor Node
    console.log(`[SessionRecovery] ${clientId}: Step 3 - Finding new node (excluding ${failedNodeId})...`);
    newContributorId = resourceManager.findSuitableContributor(requestedRamMi, requestedCpuM, failedNodeId);
    if (!newContributorId) { throw new Error(`No suitable new node found (Excluded: ${failedNodeId})`); }
    console.log(`[SessionRecovery] ${clientId}: Found new node ${newContributorId}.`);
    session = state.clientSessions.get(clientId); // Re-fetch
    if (!session || session.status !== 'recovering') throw new Error("Session state changed (finding new node).");
    session.contributorId = newContributorId;
    dashboardService.broadcastDashboardUpdate();

    // 4. Allocate Resources on New Node
    console.log(`[SessionRecovery] ${clientId}: Step 4 - Allocating resources on ${newContributorId}...`);
    if (!resourceManager.allocateResources(newContributorId, clientId, requestedRamMi, requestedCpuM)) {
      session.contributorId = null; throw new Error(`Resource allocation failed on node ${newContributorId}.`);
    }
    console.log(`[SessionRecovery] ${clientId}: Resources allocated.`);
    session = state.clientSessions.get(clientId); // Re-fetch
    if (!session || session.status !== 'recovering') throw new Error("Session state changed (allocating resources).");
    dashboardService.broadcastDashboardUpdate();

    // 5. Download Encrypted Backup from IPFS
    console.log(`[SessionRecovery] ${clientId}: Step 5 - Downloading backup ${cid}...`);
    await utils.ensureBackupDirExists();
    downloadedEncryptedPath = path.join(config.TEMP_BACKUP_DIR, `download_recovery_${clientId}_${Date.now()}.enc`);
    await ipfsService.downloadFromIpfs(cid, downloadedEncryptedPath);
    console.log(`[SessionRecovery] ${clientId}: Backup downloaded.`);

    // 6. Decrypt Backup File
    console.log(`[SessionRecovery] ${clientId}: Step 6 - Decrypting backup file...`);
    decryptedBackupPath = await encryption.decryptBackupFile(downloadedEncryptedPath, fileAesKey);
    console.log(`[SessionRecovery] ${clientId}: Backup decrypted.`);

    // 7. Spawn New Pod (Replace simulation with actual k8sUtils.spawnPod)
    console.log(`[SessionRecovery] ${clientId}: Step 7 - Spawning new pod...`);
    newPodName = `${clientId.replace("client-", "pod-")}-rec${currentAttempt}`;
    const pvcNameToUse = "syntranet-backup"; // Assume PVC needed
    await k8sUtils.spawnPod({ // Using a placeholder function, assuming k8sUtils has it
         ram: `${requestedRamMi}Mi`, cpu: `${requestedCpuM}m`, clientId: `${clientId}-recovered`,
         podNameOverride: newPodName, namespace: config.K8S_NAMESPACE, pvcName: pvcNameToUse,
     });
    console.log(`[SessionRecovery] ${clientId}: New pod ${newPodName} spawn initiated.`);
    session = state.clientSessions.get(clientId); // Re-fetch
    if (!session || session.status !== 'recovering') throw new Error("Session state changed (spawning pod).");
    session.podName = newPodName; // Assume name doesn't change
    dashboardService.broadcastDashboardUpdate();

    // 8. Wait for New Pod to be Ready
    console.log(`[SessionRecovery] ${clientId}: Step 8 - Waiting for pod ${session.podName} Ready...`);
    await k8sUtils.waitForPodReady(session.podName, config.K8S_NAMESPACE, 180);
    console.log(`[SessionRecovery] ${clientId}: Pod ${session.podName} is Ready.`);
    session = state.clientSessions.get(clientId); // Re-fetch
    if (!session || session.status !== 'recovering') throw new Error("Session state changed (waiting pod ready).");

    // 9. Restore Backup into New Pod
    console.log(`[SessionRecovery] ${clientId}: Step 9 - Restoring backup into ${session.podName}...`);
    await k8sUtils.restorePodFromBackup(decryptedBackupPath, session.podName, config.K8S_NAMESPACE, config.POD_RESTORE_TARGET_PATH);
    console.log(`[SessionRecovery] ${clientId}: Backup restored.`);

    // 10. Spawn PTY for New Pod
    console.log(`[SessionRecovery] ${clientId}: Step 10 - Spawning PTY for ${session.podName}...`);
    const newPtyProcess = k8sUtils.spawnPtyForPod(session.podName, config.K8S_NAMESPACE);
    session = state.clientSessions.get(clientId); // Re-fetch
    if (!session || session.status !== 'recovering') { if (newPtyProcess && !newPtyProcess.killed) try { newPtyProcess.kill(); } catch(e){} throw new Error("Session state changed (spawning PTY)."); }
    session.ptyProcess = newPtyProcess;
    // Listeners setup delegated to websocketHandler

    // --- Recovery Success ---
    session.status = "active";
    session.recoveryAttempt = 0;
    if (session.password) { delete session.password; console.log(`[SessionRecovery] ${clientId}: Password removed after successful recovery.`); } // Clean up WORKAROUND password

    console.log(`[SessionRecovery] ${clientId}: Recovery successful! Active on node ${newContributorId}, pod ${session.podName}.`);
    dashboardService.broadcastDashboardUpdate();

    // Notify Client
    if (session.ws?.readyState === WebSocket.OPEN) {
      try {
        session.ws.send(JSON.stringify({ type: "info", status: "recovered", message: `Service automatically recovered onto node ${newContributorId}.` }));
        setTimeout(() => {
           const currentWs = state.clientSessions.get(clientId)?.ws;
           if (currentWs?.readyState === WebSocket.OPEN) try { currentWs.send("\r\n\x1b[1;32mRecovery complete. Shell reconnected.\x1b[0m\r\n"); } catch (e) {}
        }, 500);
      } catch (e) { console.warn(`[SessionRecovery] ${clientId}: Failed to send recovery success notification: ${e.message}`); }
    }

    // Schedule Backup
    console.log(`[SessionRecovery] ${clientId}: Scheduling backup in 15s.`);
    setTimeout(() => triggerBackup(clientId), 15000);

  } catch (error) {
    // --- Recovery Failure ---
    console.error(`[SessionRecovery] Attempt ${currentAttempt} failed for ${clientId}: ${error.message}`, error.stack);
    const currentSession = state.clientSessions.get(clientId); // Re-fetch for cleanup/retry logic

    // --- Cleanup Failed Attempt ---
    if (currentSession) {
      const failedPodName = newPodName;
      const failedContributorId = newContributorId;
      console.log(`[SessionRecovery] ${clientId}: Cleaning up failed recovery attempt ${currentAttempt}...`);
      if (failedPodName) { exec(`kubectl delete pod ${failedPodName} -n ${config.K8S_NAMESPACE} --ignore-not-found=true --now --wait=false`); if (currentSession.podName === failedPodName) currentSession.podName = null; }
      if (failedContributorId) { resourceManager.releaseResources(failedContributorId, clientId, requestedRamMi, requestedCpuM); if (currentSession.contributorId === failedContributorId) currentSession.contributorId = null; }
      if (currentSession.ptyProcess) currentSession.ptyProcess = null; // Clear potentially assigned PTY
    } else {
        console.warn(`[SessionRecovery] ${clientId}: Session disappeared during error handling.`);
        if (newPodName) exec(`kubectl delete pod ${newPodName} -n ${config.K8S_NAMESPACE} --ignore-not-found=true --now --wait=false`);
    }

    // --- Retry Logic ---
    if (currentSession && currentSession.recoveryAttempt < 3) {
      const retryDelay = 10000 * currentSession.recoveryAttempt;
      console.log(`[SessionRecovery] ${clientId}: Scheduling retry (${currentSession.recoveryAttempt + 1}) in ${retryDelay / 1000}s.`);
      currentSession.status = "pending_recovery";
      dashboardService.broadcastDashboardUpdate();
      if (currentSession.ws?.readyState === WebSocket.OPEN) {
        try { currentSession.ws.send(JSON.stringify({ type: "warning", status: "recovery_retry", message: `Recovery failed: ${error.message}. Retrying in ${retryDelay / 1000}s... (Attempt ${currentSession.recoveryAttempt + 1}/3)` })); } catch (e) {}
      }
      setTimeout(() => {
        const sessionForRetry = state.clientSessions.get(clientId);
        if (sessionForRetry?.status === "pending_recovery") {
          console.log(`[SessionRecovery] ${clientId}: Executing retry (${sessionForRetry.recoveryAttempt + 1})...`);
          initiateRecovery(clientId, failedNodeId).catch(retryErr => { console.error(`[SessionRecovery] ${clientId}: Failed to initiate retry: ${retryErr.message}`); sendErrorAndCleanup(clientId, `Recovery retry failed to start: ${retryErr.message}`, 1011, "Recovery Retry Failed"); });
        } else { console.log(`[SessionRecovery] ${clientId}: Retry aborted. Status no longer pending_recovery.`); }
      }, retryDelay);
    } else { // Max attempts reached or session gone
      const finalAttempts = currentSession?.recoveryAttempt || currentAttempt;
      console.error(`[SessionRecovery] ${clientId}: Permanent recovery failure after ${finalAttempts} attempts.`);
      if (currentSession?.password) { delete currentSession.password; } // Final password cleanup
      sendErrorAndCleanup(clientId, `Automatic recovery failed permanently after ${finalAttempts} attempts: ${error.message}`, 1011, "Recovery Failed Permanently");
    }
    if (currentSession) dashboardService.broadcastDashboardUpdate(); // Update dashboard after failed attempt / setting pending

  } finally {
    // --- Common Cleanup ---
    if (fileAesKey) fileAesKey.fill(0);
    if (downloadedEncryptedPath) fsp.unlink(downloadedEncryptedPath).catch(err => { if (err.code !== 'ENOENT') console.warn(`[SessionRecovery] ${clientId}: Failed cleanup enc file: ${err.message}`);});
    if (decryptedBackupPath) fsp.unlink(decryptedBackupPath).catch(err => { if (err.code !== 'ENOENT') console.warn(`[SessionRecovery] ${clientId}: Failed cleanup dec file: ${err.message}`);});
    // Delete old pod only if recovery succeeded or failed permanently
    const finalSession = state.clientSessions.get(clientId);
    if (oldPodName && (!finalSession || finalSession.status === 'active' || finalSession.status === 'failed' || finalSession.status === 'closed')) {
        console.log(`[SessionRecovery] ${clientId}: Cleaning up original failed pod ${oldPodName}...`);
        exec(`kubectl delete pod ${oldPodName} -n ${config.K8S_NAMESPACE} --ignore-not-found=true --now --wait=false`);
    }
  }
}

module.exports = {
  initiateRecovery,
};

// Needs to be imported by websocketHandler.js (when contributor connection closes)