// sessionBackup.js
const fsp = require("fs").promises; // Use fs.promises for async file operations
const path = require("path"); // To handle file paths during cleanup // <-- CORREZIONE QUI
const config = require("../config");
const state = require("../state");
const k8sUtils = require("../infra/kubernetes/utils");
const encryption = require("../utils/encryption");
const ipfsService = require("../services/ipfsService");
const apiClient = require("../network/apiClient");
const dashboardService = require("../services/dashboardService");
// NOTE: Does not directly depend on other session modules, but is called by sessionLifecycle

/**
 * Triggers the backup process for an active client session.
 * Handles backup creation, encryption, IPFS upload, and DLT metadata storage.
 * Ensures only one backup runs at a time per client.
 * @param {string} clientId - The ID of the client session to back up.
 * @returns {Promise<void>}
 */
async function triggerBackup(clientId) {
  const session = state.clientSessions.get(clientId);

  // --- Pre-checks ---
  if (!session) return; // Session gone
  if (session.status !== "active") return; // Not active
  if (!session.podName || !session.contributorId) {
    console.warn(`[SessionBackup] Aborted for ${clientId}: Missing podName or contributorId.`);
    return;
  }
  if (session.backupInProgress) return; // Already running

  // --- DLT Credential Check (Workaround) ---
  // PROBLEM: Password likely deleted after allocation. DLT store needs it.
  // TODO: Implement a better auth mechanism (e.g., tokens)
  let canStoreInDlt = !!(session.username && session.password); // Check if password still exists (it shouldn't ideally)
  if (!canStoreInDlt) {
    console.warn(`[SessionBackup] WARNING for ${clientId}: Password missing. Cannot store backup metadata in DLT.`);
  }

  // --- Start Backup ---
  console.log(`[SessionBackup] Starting backup process for client ${clientId}, Pod: ${session.podName}`);
  session.backupInProgress = true;
  dashboardService.broadcastDashboardUpdate();

  let localBackupPath = null;
  let encryptedBackupPath = null;
  let fileAesKey = null;

  try {
    // 1. Create local backup file
    localBackupPath = await k8sUtils.backupPod(
      session.podName,
      config.K8S_NAMESPACE,
      config.POD_BACKUP_TARGET_PATH
    );
    console.log(`[SessionBackup] ${clientId}: Local backup created: ${localBackupPath}`);

    // 2. Generate file encryption key
    fileAesKey = encryption.generateAesKey();

    // 3. Encrypt backup file
    encryptedBackupPath = await encryption.encryptBackupFile(localBackupPath, fileAesKey);
    console.log(`[SessionBackup] ${clientId}: Backup file encrypted: ${encryptedBackupPath}`);

    // 4. Encrypt file key with master key
    const encryptedAesKeyHex = encryption.encryptWithMasterKey(fileAesKey);
    console.log(`[SessionBackup] ${clientId}: File AES key encrypted.`);

    // 5. Upload to IPFS
    const cid = await ipfsService.uploadToIpfsAndPin(encryptedBackupPath);
    console.log(`[SessionBackup] ${clientId}: Uploaded to IPFS. CID: ${cid}`);

    // 6. Store metadata in DLT (if possible)
    const timestamp = Date.now();
    if (canStoreInDlt) {
      await apiClient.storeBackupMetadataInDlt(
        clientId, cid, encryptedAesKeyHex, timestamp,
        session.username, session.password // Pass potentially missing password
      );
      console.log(`[SessionBackup] ${clientId}: Backup metadata stored in DLT.`);
    } else {
      console.warn(`[SessionBackup] ${clientId}: Skipped storing backup metadata in DLT.`);
    }

    // 7. Update session state
    session.backupInfo = { lastBackupCid: cid, encryptedAesKeyHex, timestamp };
    console.log(`[SessionBackup] ${clientId}: Backup process completed successfully.`);

    // 8. Notify client (success)
    if (session.ws?.readyState === WebSocket.OPEN) {
      try {
        session.ws.send(JSON.stringify({ type: "info", status: "backup_success", message: `Backup completed (CID: ${cid.substring(0, 10)}...)` }));
      } catch (e) { /* Ignore notification error */ }
    }

  } catch (error) {
    console.error(`[SessionBackup] Backup failed for client ${clientId}: ${error.message}`, error.stack);
    // Notify client (failure)
    if (session.ws?.readyState === WebSocket.OPEN) {
      try {
        session.ws.send(JSON.stringify({ type: "warning", status: "backup_failed", message: `Backup failed: ${error.message}` }));
      } catch (e) { /* Ignore notification error */ }
    }
  } finally {
    // --- Cleanup ---
    // Securely clear file key from memory
    if (fileAesKey) fileAesKey.fill(0);

    // Delete temporary local files
    if (localBackupPath) {
      fsp.unlink(localBackupPath).catch(err => { if (err.code !== 'ENOENT') console.error(`[SessionBackup] ${clientId}: Error cleaning local backup ${path.basename(localBackupPath)}: ${err.message}`); });
    }
    if (encryptedBackupPath) {
      fsp.unlink(encryptedBackupPath).catch(err => { if (err.code !== 'ENOENT') console.error(`[SessionBackup] ${clientId}: Error cleaning encrypted backup ${path.basename(encryptedBackupPath)}: ${err.message}`); });
    }

    // Reset backup flag (check if session still exists)
    const finalSession = state.clientSessions.get(clientId);
    if (finalSession) {
      finalSession.backupInProgress = false;
      console.log(`[SessionBackup] ${clientId}: Backup process finished. Flag reset.`);
      dashboardService.broadcastDashboardUpdate();
    }
  }
}

module.exports = {
  triggerBackup,
};