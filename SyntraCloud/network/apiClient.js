// apiClient.js
const axios = require("axios");
const config = require("../config");

/**
 * Generates standard headers for API calls.
 * @param {string} [username] - Optional username for potential future use in headers.
 * @param {string} [password] - Optional password for potential future use in headers.
 * @returns {object} Headers object for Axios requests.
 */
function getApiHeaders(username, password) {
  // Password is not directly used in headers here for security,
  // but kept in signature if needed for specific auth schemes later.
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": `SyntraNet-API/${config.CONTRACT_NAME}`, // Identify the client
    "bypass-tunnel-reminder": "true", // Specific header if using loca.lt or similar tunnels
    // Add Authorization header here if using Basic Auth or Bearer tokens based on login
    // e.g., if AUTH_API_ENDPOINT provides a token:
    // 'Authorization': `Bearer ${token}`
    // e.g., if using Basic Auth:
    // 'Authorization': `Basic ${Buffer.from(username + ':' + password).toString('base64')}`
    // Current implementation seems to rely on username/password in request body for DLT calls
  };
  return headers;
}

/**
 * Verifies user credentials via AUTH_API_ENDPOINT and fetches subscription info from DLT_API_ENDPOINT.
 * @param {string} userAddress - The user's blockchain address (e.g., 0x...).
 * @param {string} username - The username for authentication.
 * @param {string} password - The password for authentication.
 * @returns {Promise<object>} Result object: { accessGranted: boolean, activeNodeIds: string[], error?: string }
 */
async function verifyAccessAndGetActiveNode(userAddress, username, password) {
  // 1. Validate Input Parameters
  if (!userAddress || !userAddress.startsWith("0x") || userAddress.length !== 42) {
    console.warn("[API] Verification failed: Invalid user address format", userAddress);
    return { accessGranted: false, activeNodeIds: [], error: "Invalid address format" };
  }
  if (!username || !password) {
    console.warn("[API] Verification failed: Missing username or password for address", userAddress);
    return { accessGranted: false, activeNodeIds: [], error: "Missing credentials" };
  }

  try {
    // 2. Authenticate User via Login Endpoint
    // console.log(`[API] Attempting login for user: ${username} via ${config.AUTH_API_ENDPOINT}`);
    // We assume the login endpoint returns success (2xx) on valid credentials
    // or throws an error (4xx/5xx) on failure.
    // We don't strictly need the response body unless it contains a token needed for the next step.
    await axios.post(
      config.AUTH_API_ENDPOINT,
      { username, password }, // Send credentials in the body
      {
          headers: getApiHeaders(username, password), // Pass credentials to header function if needed there
          timeout: 10000 // 10 second timeout for login
      }
    );
    // console.log(`[API] Login successful for user: ${username}`);

    // 3. Check Subscriptions via DLT Endpoint
    // console.log(`[API] Checking subscriptions for address: ${userAddress} via ${config.DLT_API_ENDPOINT}`);
    const dltRequestBody = {
      username: username, // Pass credentials again for DLT endpoint authorization
      password: password,
      contractName: config.CONTRACT_NAME,
      contractAddress: config.CONTRACT_ADDRESS,
      method: "getSubscriptions", // DLT method to call
      args: [userAddress], // Arguments for the DLT method
    };

    const dltResponse = await axios.post(config.DLT_API_ENDPOINT, dltRequestBody, {
      headers: getApiHeaders(username, password), // Pass credentials if needed by headers
      timeout: 15000, // 15 second timeout for DLT call
    });

    // 4. Process DLT Response
    const responseData = dltResponse.data;
    // console.log("[API] DLT getSubscriptions response data:", responseData);

    // Check for success indicator and result structure based on observed original logic
    if (responseData && (responseData.success === true || responseData.result !== undefined)) {
      // Assuming 'result' contains the array of active node IDs or is empty/null
      const activeNodeIds = responseData.result || [];
      if (Array.isArray(activeNodeIds)) {
        console.log(`[API] Verification successful for ${userAddress}. Active Nodes: ${activeNodeIds.join(', ') || 'None'}`);
        return { accessGranted: true, activeNodeIds: activeNodeIds };
      } else {
           console.warn(`[API] Verification warning for ${userAddress}: DLT result was not an array.`, responseData.result);
           // Treat as access granted but no specific nodes found if the call itself seemed ok
            return { accessGranted: true, activeNodeIds: [] , error: "Subscription check returned non-array data"};
      }
    } else {
      // Login was OK, but DLT call failed logically (e.g., success: false or no result field)
      const errorMessage = responseData?.error || responseData?.message || "Unknown DLT API error structure";
      console.warn(`[API] Verification failed for ${userAddress}: Login OK, but DLT subscription check failed. API Response: ${errorMessage}`);
      return { accessGranted: true, activeNodeIds: [], error: `Login OK, but failed to check subscriptions: ${errorMessage}` };
    }

  } catch (error) {
    // 5. Handle Errors (Login or DLT call)
    const isLoginError = error.config?.url?.includes(config.AUTH_API_ENDPOINT);
    let statusCode = error.response?.status;
    let errMsg = error.message; // Default to general error message

    if (error.response) {
      // Error response from the server (4xx, 5xx)
      errMsg = error.response.data?.error || error.response.data?.message || JSON.stringify(error.response.data) || error.message;
      console.error(`[API] ${isLoginError ? 'Login' : 'DLT'} API request failed for ${username}/${userAddress} with status ${statusCode}: ${errMsg}`);
    } else if (error.request) {
      // Request made but no response received (network error, timeout)
      errMsg = `No response received from ${isLoginError ? 'Login' : 'DLT'} API. Check network or endpoint status.`;
      console.error(`[API] ${isLoginError ? 'Login' : 'DLT'} API request error for ${username}/${userAddress}: ${errMsg}`, error.code || '');
    } else {
      // Error setting up the request
      console.error(`[API] Error setting up ${isLoginError ? 'Login' : 'DLT'} API request for ${username}/${userAddress}: ${errMsg}`);
    }

    // Return specific failure reason
    if (isLoginError) {
      return { accessGranted: false, activeNodeIds: [], error: `Login failed: ${statusCode ? `(Status ${statusCode}) ` : ''}${errMsg}` };
    } else {
      // If login succeeded but DLT failed, technically access *could* be granted,
      // but we can't verify subscription. The original code seemed to treat DLT failure
      // as verification failure overall. Let's stick to that.
      // If the DLT call *itself* failed (network, timeout), treat as access denied.
      // If the DLT call returned an *error message* (step 4), that was handled above.
      return { accessGranted: false, activeNodeIds: [], error: `API Error during subscription check: ${errMsg}` };
    }
  }
}


// Placeholder/Adaptation for DLT storage functions (originally implicit in triggerBackup/initiateRecovery)

/**
 * Stores backup metadata (CID, encrypted key) in the DLT.
 * @param {string} clientId - The client identifier (used for potential association).
 * @param {string} cid - The IPFS CID of the backup.
 * @param {string} encryptedAesKeyHex - The AES key (encrypted with master key) in hex format.
 * @param {number} timestamp - The backup timestamp (Date.now()).
 * @param {string} username - Username for DLT authentication.
 * @param {string} password - Password for DLT authentication.
 * @returns {Promise<void>} Resolves on success, rejects on failure.
 * @throws {Error} If the DLT call fails.
 */
async function storeBackupMetadataInDlt(clientId, cid, encryptedAesKeyHex, timestamp, username, password) {
    console.log(`[API] Storing backup metadata for client ${clientId}: CID ${cid.substring(0,10)}...`);
    const dltRequestBody = {
      username: username,
      password: password,
      contractName: config.CONTRACT_NAME,
      contractAddress: config.CONTRACT_ADDRESS,
      method: "storeBackup", // ASSUMED DLT method name
      args: [ clientId, cid, encryptedAesKeyHex, timestamp ], // ASSUMED arguments
    };

    try {
        const response = await axios.post(config.DLT_API_ENDPOINT, dltRequestBody, {
             headers: getApiHeaders(username, password),
             timeout: 20000, // Longer timeout for potentially state-changing DLT calls
        });

        // Check response for success, similar to verification
        if (response.data && (response.data.success === true || response.data.result !== undefined)) {
             console.log(`[API] Successfully stored backup metadata for client ${clientId}. Response:`, response.data.result || response.data.message || 'OK');
             return; // Success
        } else {
            const errorMessage = response.data?.error || response.data?.message || "Unknown DLT error structure";
            throw new Error(`Failed to store backup metadata in DLT: ${errorMessage}`);
        }
    } catch (error) {
        let errMsg = error.message;
         if (error.response) {
             errMsg = error.response.data?.error || error.response.data?.message || JSON.stringify(error.response.data) || error.message;
             console.error(`[API] DLT storeBackup failed for ${clientId} with status ${error.response.status}: ${errMsg}`);
         } else if (error.request) {
             errMsg = `No response received from DLT API during storeBackup.`;
             console.error(`[API] DLT storeBackup request error for ${clientId}: ${errMsg}`, error.code || '');
         } else {
             console.error(`[API] Error setting up DLT storeBackup request for ${clientId}: ${errMsg}`);
         }
        throw new Error(`DLT storeBackup failed: ${errMsg}`);
    }
}

/**
 * Retrieves the latest backup metadata (CID, encrypted key) from the DLT for a client.
 * @param {string} clientId - The client identifier.
 * @param {string} username - Username for DLT authentication.
 * @param {string} password - Password for DLT authentication.
 * @returns {Promise<{cid: string, encryptedAesKeyHex: string, timestamp: number}|null>} Backup info or null if not found/error.
 */
async function getLatestBackupInfoFromDlt(clientId, username, password) {
    console.log(`[API] Fetching latest backup metadata for client ${clientId}`);
     const dltRequestBody = {
      username: username,
      password: password,
      contractName: config.CONTRACT_NAME,
      contractAddress: config.CONTRACT_ADDRESS,
      method: "getLatestBackup", // ASSUMED DLT method name
      args: [ clientId ], // ASSUMED arguments
    };

     try {
        const response = await axios.post(config.DLT_API_ENDPOINT, dltRequestBody, {
             headers: getApiHeaders(username, password),
             timeout: 15000,
        });

        // Check response for success and expected data structure
        if (response.data && response.data.success === true && response.data.result) {
            const { cid, encryptedAesKeyHex, timestamp } = response.data.result;
            if (cid && encryptedAesKeyHex && timestamp) {
                 console.log(`[API] Found latest backup for ${clientId}: CID ${cid.substring(0,10)}..., Timestamp ${new Date(timestamp).toISOString()}`);
                 return { cid, encryptedAesKeyHex, timestamp };
            } else {
                console.warn(`[API] DLT getLatestBackup for ${clientId} returned success but result structure is incomplete:`, response.data.result);
                return null; // Or throw error? Returning null indicates not found
            }
        } else if (response.data && response.data.success === false && response.data.message?.toLowerCase().includes('not found')) {
            // Handle case where backup explicitly not found
             console.log(`[API] No backup found in DLT for client ${clientId}.`);
             return null;
        } else {
             const errorMessage = response.data?.error || response.data?.message || "Unknown DLT error structure or non-success";
             console.warn(`[API] Failed to get latest backup metadata from DLT for ${clientId}: ${errorMessage}`);
             return null; // Indicate failure or not found
        }
    } catch (error) {
         let errMsg = error.message;
         if (error.response) {
             errMsg = error.response.data?.error || error.response.data?.message || JSON.stringify(error.response.data) || error.message;
             console.error(`[API] DLT getLatestBackup failed for ${clientId} with status ${error.response.status}: ${errMsg}`);
         } else if (error.request) {
             errMsg = `No response received from DLT API during getLatestBackup.`;
             console.error(`[API] DLT getLatestBackup request error for ${clientId}: ${errMsg}`, error.code || '');
         } else {
             console.error(`[API] Error setting up DLT getLatestBackup request for ${clientId}: ${errMsg}`);
         }
        // Don't throw here, return null to indicate failure to retrieve
        return null;
    }
}


module.exports = {
  getApiHeaders,
  verifyAccessAndGetActiveNode,
  storeBackupMetadataInDlt, // Export the new functions
  getLatestBackupInfoFromDlt, // Export the new functions
};