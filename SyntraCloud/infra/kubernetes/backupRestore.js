// k8sBackupRestore.js
const { exec, spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const config = require("../../config");
const { ensureBackupDirExists } = require("../../utils"); // Import utility

/**
 * Creates a compressed tarball backup of a directory inside a specific pod.
 * @param {string} podName - The name of the pod to back up.
 * @param {string} [namespace=config.K8S_NAMESPACE] - The Kubernetes namespace.
 * @param {string} [targetPathInsidePod=config.POD_BACKUP_TARGET_PATH] - The absolute path inside the pod to back up.
 * @returns {Promise<string>} Path to the locally created backup tar.gz file.
 * @throws {Error} If kubectl commands fail, path doesn't exist, or file operations fail.
 */
async function backupPod(
  podName,
  namespace = config.K8S_NAMESPACE,
  targetPathInsidePod = config.POD_BACKUP_TARGET_PATH
) {
  await ensureBackupDirExists();
  const backupFileName = `backup-${podName}-${Date.now()}.tar.gz`;
  const localBackupPath = path.join(config.TEMP_BACKUP_DIR, backupFileName);
  console.log(`[K8sBackupRestore] Starting backup for pod ${podName}:${targetPathInsidePod} to ${localBackupPath}`);

  // 1. Check path existence
  const checkArgs = ["exec", podName, "-n", namespace, "--", "test", "-e", targetPathInsidePod];
  console.log(`[K8sBackupRestore] Checking path: kubectl ${checkArgs.join(" ")}`);
  try {
    await new Promise((resolve, reject) => {
      exec(`kubectl ${checkArgs.join(" ")}`, (err, stdout, stderr) => {
        if (err) { reject(new Error(`Backup target path '${targetPathInsidePod}' not found in pod ${podName}. Stderr: ${stderr || err.message}`)); }
        else { console.log(`[K8sBackupRestore] Path ${targetPathInsidePod} exists.`); resolve(); }
      });
    });
  } catch (checkError) { throw checkError; }

  // 2. Execute tar and stream output
  const writeStream = fs.createWriteStream(localBackupPath);
  const tarTargetPath = targetPathInsidePod.startsWith("/") ? targetPathInsidePod.substring(1) : targetPathInsidePod;
  const tarArgs = ["exec", podName, "-n", namespace, "--", "tar", "czf", "-", "-C", "/", tarTargetPath];
  console.log(`[K8sBackupRestore] Executing backup command: kubectl ${tarArgs.join(" ")}`);
  const kubectl = spawn("kubectl", tarArgs);
  kubectl.stdout.pipe(writeStream);
  let stderrData = "";
  kubectl.stderr.on("data", (data) => { stderrData += data.toString(); });

  return new Promise((resolve, reject) => {
    kubectl.on("close", (code) => {
      writeStream.end();
      writeStream.on("finish", async () => {
        console.log(`[K8sBackupRestore] kubectl backup process for ${podName} exited code ${code}.`);
        if (stderrData.trim()) console.warn(`[K8sBackupRestore] Backup stderr for ${podName}: ${stderrData.trim()}`);
        try {
          const stats = await fsp.stat(localBackupPath);
          if (stats.size === 0 && !stderrData.includes("Removing leading") && !stderrData.includes("empty archive")) {
            console.warn(`[K8sBackupRestore] Warning: Backup file ${localBackupPath} is empty.`);
          } else if (stats.size === 0) {
            console.log(`[K8sBackupRestore] Backup for ${podName} resulted in an empty archive.`);
          }
        } catch (statError) { console.error(`[K8sBackupRestore] Error: Failed to stat backup file ${localBackupPath}.`, statError); }

        const stderrLower = stderrData.toLowerCase();
        const hasCriticalError = code !== 0 || stderrLower.includes("error") || stderrLower.includes("fail") || stderrLower.includes("cannot open") || stderrLower.includes("not found");

        if (!hasCriticalError) {
          console.log(`[K8sBackupRestore] Backup successful: ${localBackupPath}`);
          resolve(localBackupPath);
        } else {
          const errorMsg = `kubectl backup tar failed for ${podName} (code ${code}): ${stderrData || "Unknown error"}`;
          console.error(`[K8sBackupRestore] ${errorMsg}`);
          fsp.unlink(localBackupPath).catch(err => { if (err.code !== 'ENOENT') console.error(`[K8sBackupRestore] Failed cleanup failed backup file ${localBackupPath}: ${err.message}`); });
          reject(new Error(errorMsg));
        }
      });
      writeStream.on("error", (err) => {
        console.error(`[K8sBackupRestore] Write stream error for ${localBackupPath}: ${err.message}`);
        fsp.unlink(localBackupPath).catch(unlinkErr => { if (unlinkErr.code !== 'ENOENT') console.error(`[K8sBackupRestore] Failed cleanup on write error ${localBackupPath}: ${unlinkErr.message}`); });
        reject(new Error(`Backup write stream error: ${err.message}`));
      });
    });
    kubectl.on("error", (err) => {
      console.error(`[K8sBackupRestore] Failed to spawn kubectl: ${err.message}`);
      writeStream.end();
      fsp.unlink(localBackupPath).catch(unlinkErr => { if (unlinkErr.code !== 'ENOENT') console.error(`[K8sBackupRestore] Failed cleanup on spawn error ${localBackupPath}: ${unlinkErr.message}`); });
      reject(new Error(`kubectl spawn error: ${err.message}`));
    });
  });
}

/**
 * Restores a backup tarball into a new pod.
 * @param {string} decryptedBackupPath - Local path to the decrypted .tar.gz backup file.
 * @param {string} newPodName - The name of the target pod for restoration.
 * @param {string} [namespace=config.K8S_NAMESPACE] - The Kubernetes namespace.
 * @param {string} [targetPathInsidePod=config.POD_RESTORE_TARGET_PATH] - The absolute path inside the pod where the archive should be extracted.
 * @returns {Promise<void>} Resolves on successful restore, rejects on failure.
 * @throws {Error} If file access, kubectl cp, or kubectl exec tar fails.
 */
async function restorePodFromBackup(
  decryptedBackupPath,
  newPodName,
  namespace = config.K8S_NAMESPACE,
  targetPathInsidePod = config.POD_RESTORE_TARGET_PATH
) {
  const backupFileName = path.basename(decryptedBackupPath);
  const remoteTempPath = `/tmp/${backupFileName}`;
  console.log(`[K8sBackupRestore] Starting restore for pod ${newPodName} from ${backupFileName} to ${targetPathInsidePod}`);

  // 1. Verify backup file
  try {
    const stats = await fsp.stat(decryptedBackupPath);
    if (stats.size === 0) console.warn(`[K8sBackupRestore] Warning: Decrypted backup file '${decryptedBackupPath}' is empty.`);
    console.log(`[K8sBackupRestore] Verified backup file ${decryptedBackupPath} (Size: ${stats.size} bytes).`);
  } catch (statError) { throw new Error(`Cannot access decrypted backup file: ${statError.message}`); }

  // 2. Copy backup into pod
  const cpArgs = ["cp", decryptedBackupPath, `${namespace}/${newPodName}:${remoteTempPath}`];
  console.log(`[K8sBackupRestore] Copying backup to pod: kubectl ${cpArgs.join(" ")}`);
  try {
    await new Promise((resolve, reject) => {
      const cpProcess = spawn("kubectl", cpArgs, { timeout: 120000 });
      let cpStdout = ""; let cpStderr = "";
      cpProcess.stdout.on("data", (data) => cpStdout += data.toString());
      cpProcess.stderr.on("data", (data) => cpStderr += data.toString());
      cpProcess.on("close", (code) => {
        if (code === 0) { console.log(`[K8sBackupRestore] Copied backup to ${newPodName}:${remoteTempPath}`); resolve(); }
        else { reject(new Error(`kubectl cp failed (code ${code}): ${cpStderr || cpStdout || "Unknown copy error"}`)); }
      });
      cpProcess.on("error", (err) => reject(new Error(`kubectl cp spawn error: ${err.message}`)));
    });
  } catch (cpError) { throw new Error(`Backup copy into pod ${newPodName} failed: ${cpError.message}`); }

  // 3. Ensure target directory exists
  const mkdirArgs = ["exec", newPodName, "-n", namespace, "--", "mkdir", "-p", targetPathInsidePod];
  console.log(`[K8sBackupRestore] Ensuring target dir: kubectl ${mkdirArgs.join(" ")}`);
  try {
    await new Promise((resolve) => {
      exec(`kubectl ${mkdirArgs.join(" ")}`, (err, stdout, stderr) => {
        if (err) console.warn(`[K8sBackupRestore] Warning: Failed to ensure target dir ${targetPathInsidePod} (may be ok): ${stderr || err.message}`);
        else console.log(`[K8sBackupRestore] Ensured target dir ${targetPathInsidePod} in pod ${newPodName}.`);
        resolve();
      });
    });
  } catch (mkdirErr) { console.warn(`[K8sBackupRestore] Warning: Exception during mkdir: ${mkdirErr.message}`); }

  // 4. Extract tarball inside pod
  const tarArgs = ["exec", newPodName, "-n", namespace, "--", "tar", "xzf", remoteTempPath, "-C", targetPathInsidePod];
  console.log(`[K8sBackupRestore] Extracting backup in pod: kubectl ${tarArgs.join(" ")}`);
  try {
    await new Promise((resolve, reject) => {
      const tarProcess = spawn("kubectl", tarArgs, { timeout: 180000 });
      let tarStdout = ""; let tarStderr = "";
      tarProcess.stdout.on("data", (data) => tarStdout += data.toString());
      tarProcess.stderr.on("data", (data) => tarStderr += data.toString());
      tarProcess.on("close", (code) => {
        if (tarStdout.trim()) console.log(`[K8sBackupRestore] Restore stdout (tar): ${tarStdout.trim()}`);
        if (tarStderr.trim()) console.warn(`[K8sBackupRestore] Restore stderr (tar): ${tarStderr.trim()}`);
        const stderrLower = tarStderr.toLowerCase();
        const hasCriticalError = code !== 0 || stderrLower.includes("error") || stderrLower.includes("fail") || stderrLower.includes("cannot open") || stderrLower.includes("no such file");
        if (!hasCriticalError) {
          console.log(`[K8sBackupRestore] Extracted backup in pod ${newPodName} to ${targetPathInsidePod}`);
          resolve();
        } else {
          reject(new Error(`kubectl exec tar extract failed (code ${code}): ${tarStderr || tarStdout || "Unknown extraction error"}`));
        }
      });
      tarProcess.on("error", (err) => reject(new Error(`kubectl exec tar xzf spawn error: ${err.message}`)));
    });
  } catch (tarError) { throw new Error(`Backup extraction in pod ${newPodName} failed: ${tarError.message}`); }
  finally {
    // 5. Clean up temporary file (best effort)
    const rmArgs = ["exec", newPodName, "-n", namespace, "--", "rm", "-f", remoteTempPath];
    console.log(`[K8sBackupRestore] Cleaning up temp file in pod: kubectl ${rmArgs.join(" ")}`);
    exec(`kubectl ${rmArgs.join(" ")}`, (err, stdout, stderr) => {
      if (err) console.warn(`[K8sBackupRestore] Warning: Failed remove temp backup ${remoteTempPath} from ${newPodName}: ${stderr || err.message}`);
    });
  }
}

module.exports = {
  backupPod,
  restorePodFromBackup,
};