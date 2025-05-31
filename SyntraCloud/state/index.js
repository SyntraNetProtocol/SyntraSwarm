// state.js

// Mappe per tenere traccia dello stato
const contributorNodes = new Map(); // K: nodeId, V: { ws, id, ram, cpu, storage, availableRam, availableCpu, activeTerminals, lastSeen, address, isAlive }
const clientSessions = new Map(); // K: clientId, V: { id, ws, status, ptyProcess, podName, contributorId, userAddress, username, /* password (temp) */, activeNodeId, requestedRamMi, requestedCpuM, backupInProgress, backupInfo, recoveryAttempt, isAlive }
const dashboardSockets = new Map(); // K: dashboardId, V: { ws, id, isAlive }

// Variabili per servizi e intervalli
let ipfsClient = null;
let keepAliveInterval = null;

module.exports = {
  contributorNodes,
  clientSessions,
  dashboardSockets,
  getIpfsClient: () => ipfsClient,
  setIpfsClient: (client) => { ipfsClient = client; },
  getKeepAliveInterval: () => keepAliveInterval,
  setKeepAliveInterval: (intervalId) => { keepAliveInterval = intervalId; },
};