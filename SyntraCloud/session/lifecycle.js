// sessionLifecycle.js
const WebSocket = require("ws");
const { exec } = require("child_process");
const config = require("../config");
const state = require("../state");
const apiClient = require("../network/apiClient");
const resourceManager = require("../services/resourceManager");
const k8sUtils = require("../infra/kubernetes/utils");
const utils = require("../utils/index");
const dashboardService = require("../services/dashboardService");
const { sendErrorAndCleanup, cleanupClientSession } = require("./cleanup");
const { triggerBackup } = require("./backup");
// NON importare websocketHandler

/**
 * Handles the result of the user verification process.
 * Proceeds to allocate resources if verification succeeds.
 * Returns a Promise that resolves when allocation/PTY setup is complete,
 * or rejects if verification/allocation fails.
 * @param {string} clientId - The ID of the client session.
 * @param {object} verificationResult - The result from apiClient.verifyAccessAndGetActiveNode.
 * @returns {Promise<void>} Resolves on successful allocation, rejects on failure.
 */
async function handleVerificationResult(clientId, verificationResult) { // Aggiunto async qui
  const session = state.clientSessions.get(clientId);
  if (!session) {
    console.warn(`[SessionLife] handleVerificationResult: Session ${clientId} not found.`);
    // Rifiuta la promise se la sessione non c'è
    return Promise.reject(new Error(`Session ${clientId} not found during verification result handling.`));
  }

  if (session.ws?.readyState !== WebSocket.OPEN) {
    console.warn(`[SessionLife] handleVerificationResult: WebSocket for session ${clientId} closed.`);
    // Non serve cleanup qui perché la chiamata originale fallirà probabilmente
    return Promise.reject(new Error(`WebSocket closed for session ${clientId} during verification result handling.`));
  }

  if (session.status !== "verifying") {
    console.warn(`[SessionLife] handleVerificationResult: Session ${clientId} unexpected status ${session.status}.`);
    // Rifiuta la promise se lo stato è sbagliato
    return Promise.reject(new Error(`Session ${clientId} has unexpected status ${session.status}`));
  }

  if (verificationResult.accessGranted) {
    console.log(`[SessionLife] Verification successful for ${clientId}. Address: ${session.userAddress}`);
    session.status = "allocating";
    session.activeNodeId = verificationResult.activeNodeIds?.length > 0 ? verificationResult.activeNodeIds[0] : null;

    const message = `Access verified. Checking resource availability and allocating shell...`;
    try {
      session.ws.send(JSON.stringify({ type: "verification_success", status: "allocating", message: message }));
    } catch (e) {
      console.error(`[SessionLife] Error sending verification success to ${clientId}:`, e.message);
      // Non chiamare cleanup qui, lascia che la promise rifiuti
      throw new Error(`Error sending verification success message: ${e.message}`); // Rilancia per rifiutare la promise
    }

    dashboardService.broadcastDashboardUpdate();

    try {
        // **ATTENDI** il completamento di handleTerminalRequest
        await handleTerminalRequest(clientId);

        // Se handleTerminalRequest ha successo (non lancia errori):
        const currentSession = state.clientSessions.get(clientId);
        if (currentSession && currentSession.status === "allocating") { // Dovrebbe essere ancora 'allocating' qui
            currentSession.status = "active"; // Ora marca come attivo
            if (currentSession.password) { delete currentSession.password; console.log(`[SessionLife] Password removed for ${clientId}.`); }

            console.log(`[SessionLife] Terminal ready for ${clientId}. Pod: ${currentSession.podName}, Node: ${currentSession.contributorId}`);

            if (currentSession.ws?.readyState === WebSocket.OPEN) {
                try { currentSession.ws.send(JSON.stringify({ type: "terminal_ready", status: "active", message: "Terminal session is ready." })); }
                catch (e) { console.warn(`[SessionLife] Failed send terminal_ready to ${clientId}: ${e.message}`); }
            }
            dashboardService.broadcastDashboardUpdate();

            console.log(`[SessionLife] Scheduling initial backup for ${clientId} in 10s.`);
            setTimeout(() => triggerBackup(clientId), 10000);

            // Risolvi la Promise per segnalare successo completo al chiamante (websocketHandler)
            return Promise.resolve();

        } else {
             console.warn(`[SessionLife] Allocation for ${clientId} finished, but status is ${currentSession?.status || 'missing'}.`);
             if (currentSession?.password) { delete currentSession.password; }
             // Rifiuta se lo stato non è corretto dopo handleTerminalRequest
             throw new Error(`Session ${clientId} ended with unexpected status ${currentSession?.status || 'missing'}`);
        }

    } catch (allocError) {
        // handleTerminalRequest ha già fatto cleanup e inviato errore al client
        console.error(`[SessionLife] Terminal allocation process failed for ${clientId} (error caught in handleVerificationResult): ${allocError.message}`);
        const failedSession = state.clientSessions.get(clientId);
        if (failedSession?.password) { delete failedSession.password; }
        // Rilancia l'errore per rifiutare la Promise restituita da handleVerificationResult
        throw allocError;
    }

  } else {
    // Verification failed
    console.warn(`[SessionLife] Verification failed for ${clientId}: ${verificationResult.error || "Unknown"}`);
    if (session.password) { delete session.password; console.log(`[SessionLife] Password removed for ${clientId} after verification failure.`); }
    // Invia errore e pulisci (non serve rilanciare perché questo percorso è sincrono)
    sendErrorAndCleanup(clientId, `Verification failed: ${verificationResult.error || "Unknown reason."}`, 1008, "Verification Failed");
    // Rifiuta la Promise per segnalare fallimento al chiamante
    return Promise.reject(new Error(`Verification failed: ${verificationResult.error || "Unknown reason."}`));
  }
}


/**
 * Handles requesting and setting up terminal: finds node, allocates, spawns pod, waits, spawns PTY.
 * Returns a promise that resolves on success (PTY created), rejects on failure.
 * Cleanup on failure is handled internally *before* rejecting.
 * @param {string} clientId - The ID of the client session.
 * @returns {Promise<void>}
 */
async function handleTerminalRequest(clientId) {
    const functionName = `handleTerminalRequest`;
    console.log(`[SessionLife][${clientId}] ${functionName}: ENTER`);

    let session = state.clientSessions.get(clientId);
    if (!session) throw new Error(`[${clientId}] Session disappeared before allocation start.`);
    if (session.status !== "allocating") throw new Error(`Invalid session state: ${session.status}`);

    const requestedRamMi = session.requestedRamMi || 100;
    const requestedCpuM = session.requestedCpuM || 100;
    session.requestedRamMi = requestedRamMi;
    session.requestedCpuM = requestedCpuM;
    console.log(`[SessionLife][${clientId}] Requesting: ${requestedRamMi}Mi RAM, ${requestedCpuM}m CPU`);

    let contributorId = null;
    let podName = null;
    let resourcesAllocatedOnNodeId = null;
    let podSpawnAttempted = false;
    let ptyProcess = null;

    try {
        // Step 1: Find Contributor
        contributorId = resourceManager.findSuitableContributor(requestedRamMi, requestedCpuM);
        if (!contributorId) throw new Error("No suitable contributor node available.");
        console.log(`[SessionLife][${clientId}] Found contributor ${contributorId}`);
        session = state.clientSessions.get(clientId);
        if (!session || session.status !== "allocating") throw new Error(`Session state changed (find node).`);
        session.contributorId = contributorId;
        dashboardService.broadcastDashboardUpdate();

        // Step 2: Allocate Resources
        if (!resourceManager.allocateResources(contributorId, clientId, requestedRamMi, requestedCpuM)) {
            session.contributorId = null; throw new Error(`Failed to allocate resources on node ${contributorId}.`);
        }
        resourcesAllocatedOnNodeId = contributorId;
        console.log(`[SessionLife][${clientId}] Resources allocated on ${contributorId}.`);
        session = state.clientSessions.get(clientId);
        if (!session || session.status !== "allocating") throw new Error(`Session state changed (alloc res).`);
        dashboardService.broadcastDashboardUpdate();

        // Step 3: Spawn Pod
        const pvcNameToUse = "syntranet-backup";
        podName = `${session.id.replace("client-", "pod-")}-${utils.generateId("").substring(0, 6)}`;
        console.log(`[SessionLife][${clientId}] Spawning pod ${podName} (PVC: ${pvcNameToUse || 'emptyDir'})...`);
        podSpawnAttempted = true;
        const spawnedPodName = await k8sUtils.spawnPod({
            ram: `${requestedRamMi}Mi`, cpu: `${requestedCpuM}m`, clientId: clientId,
            podNameOverride: podName, namespace: config.K8S_NAMESPACE, pvcName: pvcNameToUse,
        });
        console.log(`[SessionLife][${clientId}] Pod ${spawnedPodName} spawn initiated.`);
        session = state.clientSessions.get(clientId);
        if (!session || session.status !== "allocating") throw new Error(`Session state changed (spawn pod).`);
        session.podName = spawnedPodName;
        dashboardService.broadcastDashboardUpdate();

        // Step 4: Wait for Pod Ready
        console.log(`[SessionLife][${clientId}] Waiting for pod ${session.podName} Ready...`);
        await k8sUtils.waitForPodReady(session.podName, config.K8S_NAMESPACE);
        console.log(`[SessionLife][${clientId}] Pod ${session.podName} is Ready.`);
        session = state.clientSessions.get(clientId);
        if (!session || session.status !== "allocating") throw new Error(`Session state changed (wait ready).`);

        // Step 5: Spawn PTY
        console.log(`[SessionLife][${clientId}] Spawning PTY for pod ${session.podName}...`);
        ptyProcess = k8sUtils.spawnPtyForPod(session.podName, config.K8S_NAMESPACE);
        console.log(`[SessionLife][${clientId}] PTY spawned (PID: ${ptyProcess.pid}).`);
        session = state.clientSessions.get(clientId);
        if (!session || session.status !== "allocating") {
            if (ptyProcess && !ptyProcess.killed) try { ptyProcess.kill(); } catch(e){}
            throw new Error(`Session state changed (spawn pty).`);
        }
        session.ptyProcess = ptyProcess; // Assegna PTY
        console.log(`[SessionLife][${clientId}] PTY process assigned to session.`);

        console.log(`[SessionLife][${clientId}] Allocation process complete. PTY ready.`);
        // La Promise si risolve implicitamente qui (successo)

    } catch (error) {
        // --- Catch Block & Cleanup ---
        console.error(`[SessionLife][${clientId}] !ERROR! during allocation: ${error.message}`);
        console.log(`[SessionLife][${clientId}] Starting cleanup due to error...`);
        const cleanupSession = state.clientSessions.get(clientId);
        const podNameToDelete = cleanupSession?.podName || podName;
        const contributorToRelease = cleanupSession?.contributorId || resourcesAllocatedOnNodeId;
        const ramToRelease = cleanupSession?.requestedRamMi || requestedRamMi;
        const cpuToRelease = cleanupSession?.requestedCpuM || requestedCpuM;

        // If no contributor available, report error but retain session for reattach
        if (error.message.includes('No suitable contributor')) {
            sendErrorAndCleanup(clientId, `Shell allocation failed: ${error.message}`, 0, `Allocation Failed`);
            console.log(`[SessionLife][${clientId}] EXIT (Allocation failure, session preserved)`);
            return; // Do not cleanup session or resources, allow reattach later
        }
        // Full cleanup for other errors
        if (ptyProcess && !ptyProcess.killed) { try { ptyProcess.kill(); } catch (e) {} }
        if (cleanupSession?.ptyProcess) cleanupSession.ptyProcess = null;
        if (podNameToDelete && podSpawnAttempted) {
            exec(`kubectl delete pod ${podNameToDelete} -n ${config.K8S_NAMESPACE} --ignore-not-found=true --now --wait=false`);
            if (cleanupSession?.podName === podNameToDelete) cleanupSession.podName = null;
        }
        if (contributorToRelease) {
            resourceManager.releaseResources(contributorToRelease, clientId, ramToRelease, cpuToRelease);
            if (cleanupSession?.contributorId === contributorToRelease) cleanupSession.contributorId = null;
            dashboardService.broadcastDashboardUpdate();
        }
        sendErrorAndCleanup(clientId, `Shell allocation failed: ${error.message}`, 1011, `Allocation Failed`);
        console.log(`[SessionLife][${clientId}] EXIT (Error Path)`);
        // Rilancia l'errore per far rigettare la Promise
        throw error;
    }
    // Success path
    console.log(`[SessionLife][${clientId}] EXIT (Success Path)`);
    // La promise si risolve implicitamente
}

module.exports = {
  handleVerificationResult,
  // Non esportiamo handleTerminalRequest perché è interno
};