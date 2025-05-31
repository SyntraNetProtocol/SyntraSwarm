// resourceManager.js
const WebSocket = require("ws"); // Required to check WebSocket state
const state = require("../state");
const { parseResourceValue } = require("../utils");
// const dashboardService = require('./dashboardService'); // Import if broadcasting updates directly from here

/**
 * Finds a suitable contributor node based on requested resources, excluding a specific node.
 * Checks for connectivity, liveness, and available resources.
 * @param {number} [requestedRamMi=100] - Requested RAM in MiB.
 * @param {number} [requestedCpuM=100] - Requested CPU in millicores.
 * @param {string|null} [excludeNodeId=null] - Node ID to exclude from the search.
 * @returns {string|null} The ID of a suitable contributor node, or null if none found.
 */
function findSuitableContributor(
  requestedRamMi = 100,
  requestedCpuM = 100,
  excludeNodeId = null
) {
  if (state.contributorNodes.size === 0) {
    console.log("[ResMan] No contributor nodes registered.");
    return null;
  }

  // console.log(`[ResMan] Searching for contributor (Req: ${requestedRamMi}Mi RAM, ${requestedCpuM}m CPU, Exclude: ${excludeNodeId || 'None'})`);

  // Iterate through available nodes
  for (const [nodeId, nodeInfo] of state.contributorNodes.entries()) {
    // Skip excluded node
    if (nodeId === excludeNodeId) {
      // console.log(`[ResMan] Skipping excluded node ${nodeId}`);
      continue;
    }

    // Check WebSocket state and liveness flag
    const wsState = nodeInfo.ws ? nodeInfo.ws.readyState : "N/A";
    if (!nodeInfo.ws || wsState !== WebSocket.OPEN || !nodeInfo.isAlive) {
    //   console.log(`[ResMan] Skipping node ${nodeId}: Not connected or not alive (State: ${wsState}, Alive: ${nodeInfo.isAlive})`);
      continue;
    }

    // Parse available resources safely using the utility function
    const availableRamMi = parseResourceValue(nodeInfo.availableRam || "0Mi");
    const availableCpuM = parseResourceValue(nodeInfo.availableCpu || "0m");
    // console.log(`[ResMan] Node ${nodeId}: Available RAM=${availableRamMi}Mi, CPU=${availableCpuM}m`);


    // Check if resources are sufficient
    if (availableRamMi >= requestedRamMi && availableCpuM >= requestedCpuM) {
      console.log(`[ResMan] Found suitable node: ${nodeId}`);
      return nodeId; // Found a suitable node
    } else {
    //   console.log(`[ResMan] Node ${nodeId}: Insufficient resources.`);
    }
  }

  console.log("[ResMan] No suitable contributor node found matching the criteria.");
  return null; // No suitable node found
}

/**
 * Attempts to allocate resources on a specific contributor node for a client.
 * Decrements available resources and adds client ID to active terminals.
 * @param {string} nodeId - The ID of the contributor node.
 * @param {string} clientId - The ID of the client requesting resources.
 * @param {number} [requestedRamMi=100] - RAM to allocate in MiB.
 * @param {number} [requestedCpuM=100] - CPU to allocate in millicores.
 * @returns {boolean} True if allocation was successful, false otherwise.
 */
function allocateResources(
  nodeId,
  clientId,
  requestedRamMi = 100,
  requestedCpuM = 100
) {
  const node = state.contributorNodes.get(nodeId);

  // Check if node exists and is connected
  if (!node || node.ws?.readyState !== WebSocket.OPEN) {
    console.warn(`[ResMan] Allocation failed: Node ${nodeId} not found or not connected.`);
    return false;
  }

  // Parse current available resources
  const currentRamMi = parseResourceValue(node.availableRam);
  const currentCpuM = parseResourceValue(node.availableCpu);

  // Calculate new available resources
  const newRamMi = currentRamMi - requestedRamMi;
  const newCpuM = currentCpuM - requestedCpuM;

  // Check if allocation is possible
  if (newRamMi < 0 || newCpuM < 0) {
    console.warn(`[ResMan] Allocation failed on node ${nodeId} for client ${clientId}: Insufficient resources (Needs ${requestedRamMi}Mi/${requestedCpuM}m, Has ${currentRamMi}Mi/${currentCpuM}m)`);
    return false;
  }

  // Update node's available resources
  node.availableRam = `${newRamMi}Mi`;
  node.availableCpu = `${newCpuM}m`;

  // Track the active terminal/client on this node
  if (!node.activeTerminals) { // Defensive check
      node.activeTerminals = new Set();
  }
  node.activeTerminals.add(clientId);

  // Update last seen time as activity occurred
  node.lastSeen = Date.now();

  console.log(`[ResMan] Allocated ${requestedRamMi}Mi RAM, ${requestedCpuM}m CPU to client ${clientId} on node ${nodeId}. New available: ${node.availableRam}, ${node.availableCpu}`);

  // Optionally broadcast update immediately after allocation
  // dashboardService.broadcastDashboardUpdate(); // If needed

  return true;
}

/**
 * Releases resources previously allocated to a client on a specific node.
 * Increments available resources (up to the node's maximum) and removes client ID.
 * @param {string} nodeId - The ID of the contributor node.
 * @param {string} clientId - The ID of the client whose resources are being released.
 * @param {number} [releasedRamMi=100] - RAM to release in MiB. Defaults should match allocation.
 * @param {number} [releasedCpuM=100] - CPU to release in millicores. Defaults should match allocation.
 */
function releaseResources(
  nodeId,
  clientId,
  releasedRamMi = 100, // Default should ideally come from session data if possible
  releasedCpuM = 100  // Default should ideally come from session data if possible
) {
  const node = state.contributorNodes.get(nodeId);

  // If node doesn't exist anymore, nothing to release
  if (!node) {
    console.warn(`[ResMan] Resource release skipped: Node ${nodeId} not found (possibly disconnected).`);
    return;
  }

  // Get current available and node's total capacity
  const currentRamMi = parseResourceValue(node.availableRam);
  const currentCpuM = parseResourceValue(node.availableCpu);
  const maxRamMi = parseResourceValue(node.ram); // Node's total RAM
  const maxCpuM = parseResourceValue(node.cpu);   // Node's total CPU

  // Ensure released values are valid numbers
  const validReleasedRam = isNaN(releasedRamMi) ? 0 : releasedRamMi;
  const validReleasedCpu = isNaN(releasedCpuM) ? 0 : releasedCpuM;

  // Calculate new available resources, ensuring not to exceed the node's maximum capacity
  const newRamMi = Math.min(maxRamMi, currentRamMi + validReleasedRam);
  const newCpuM = Math.min(maxCpuM, currentCpuM + validReleasedCpu);

  node.availableRam = `${newRamMi}Mi`;
  node.availableCpu = `${newCpuM}m`;

  // Remove the client from the active terminals set
  if (node.activeTerminals) {
      const deleted = node.activeTerminals.delete(clientId);
      if (!deleted) {
        //   console.warn(`[ResMan] Client ${clientId} was not found in active terminals of node ${nodeId} during release.`);
      }
  } else {
    //   console.warn(`[ResMan] Node ${nodeId} had no activeTerminals set during release for client ${clientId}.`);
  }


  // Update last seen time as activity occurred
  node.lastSeen = Date.now();

  console.log(`[ResMan] Released ${validReleasedRam}Mi RAM, ${validReleasedCpu}m CPU from client ${clientId} on node ${nodeId}. New available: ${node.availableRam}, ${node.availableCpu}`);

  // Optionally broadcast update immediately after release
  // dashboardService.broadcastDashboardUpdate(); // If needed
}

module.exports = {
  findSuitableContributor,
  allocateResources,
  releaseResources,
};