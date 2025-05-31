// ipfsService.js
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const config = require("../config/index");
const state = require("../state/index"); // To get/set ipfsClient

// Dynamically import ipfs-http-client
let createIpfsClient; // Variable to hold the imported function

/**
 * Initializes the IPFS client using the configured API URL.
 * Must be called before using other IPFS functions.
 * @throws {Error} If IPFS client cannot be created or connection fails.
 */
async function initializeIpfsClient() {
  if (state.getIpfsClient()) {
    console.log("[IPFS] IPFS client already initialized.");
    return;
  }
  try {
    // Dynamically import the 'create' function
    if (!createIpfsClient) {
        const { create } = await import("ipfs-http-client");
        createIpfsClient = create;
    }

    console.log(`[IPFS] Initializing IPFS client for URL: ${config.IPFS_API_URL}`);
    const client = createIpfsClient({ url: config.IPFS_API_URL });

    // Test connection by fetching version (with timeout)
    const version = await client.version({ timeout: 5000 });
    console.log("[IPFS] IPFS client connected successfully. Version:", version);

    state.setIpfsClient(client); // Store the initialized client in global state
  } catch (error) {
    console.error(`[IPFS] FATAL ERROR: Failed to initialize IPFS client at ${config.IPFS_API_URL}: ${error.message}`, error.cause || '');
    // Re-throw a more specific error to be caught by main initialization
    throw new Error(`IPFS client initialization failed: ${error.message}`);
  }
}

/**
 * Uploads a file to IPFS and pins it.
 * @param {string} filePath - The path to the local file to upload.
 * @returns {Promise<string>} The IPFS CID (Content Identifier) of the uploaded file.
 * @throws {Error} If IPFS client is not initialized or upload/pin fails.
 */
async function uploadToIpfsAndPin(filePath) {
  const ipfsClient = state.getIpfsClient();
  if (!ipfsClient) {
    throw new Error("IPFS client not initialized. Call initializeIpfsClient first.");
  }

  try {
    const fileContent = await fsp.readFile(filePath);
    if (fileContent.length === 0) {
        console.warn(`[IPFS] Uploading empty file: ${path.basename(filePath)}`);
        // IPFS can handle empty files, they result in a specific CID:
        // QmUNLLsPACCz1vLxQVkXqqLX5R1XeaVztonDriVVhRfFt4
    }

    // console.log(`[IPFS] Uploading file ${path.basename(filePath)} (${fileContent.length} bytes) to IPFS and pinning...`);
    // The 'add' operation automatically pins by default in recent versions,
    // but explicitly setting pin: true ensures this behavior.
    const addResult = await ipfsClient.add(fileContent, { pin: true });
    const cid = addResult.cid.toString();

    console.log(`[IPFS] File ${path.basename(filePath)} uploaded successfully. CID: ${cid}`);
    return cid;
  } catch (error) {
    console.error(`[IPFS] IPFS Upload/Pin failed for file ${filePath}: ${error.message}`, error.cause || '');
    throw new Error(`IPFS Upload/Pin failed: ${error.message}`);
  }
}

/**
 * Downloads a file from IPFS using its CID.
 * @param {string} cid - The IPFS CID of the file to download.
 * @param {string} destinationPath - The local path where the downloaded file should be saved.
 * @returns {Promise<string>} The destination path where the file was saved.
 * @throws {Error} If IPFS client not initialized, download fails, CID not found, or timeout occurs.
 */
async function downloadFromIpfs(cid, destinationPath) {
  const ipfsClient = state.getIpfsClient();
  if (!ipfsClient) {
    throw new Error("IPFS client not initialized. Call initializeIpfsClient first.");
  }

  console.log(`[IPFS] Attempting to download CID ${cid} to ${destinationPath}...`);
  const writeStream = fs.createWriteStream(destinationPath);
  let downloadedBytes = 0;

  try {
    // Use ipfsClient.cat() which returns an async iterable stream
    const stream = ipfsClient.cat(cid, { timeout: 120000 }); // 2 minute timeout

    for await (const chunk of stream) {
      writeStream.write(chunk);
      downloadedBytes += chunk.length;
    }
    writeStream.end(); // Close the stream once all chunks are written

    // Wait for the stream to finish writing to disk
    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject); // Handle write stream errors
    });

    console.log(`[IPFS] Successfully downloaded CID ${cid} (${downloadedBytes} bytes) to ${destinationPath}`);

    if (downloadedBytes === 0) {
        console.warn(`[IPFS] Downloaded file for CID ${cid} is empty.`);
    }

    return destinationPath;

  } catch (error) {
    console.error(`[IPFS] IPFS Download failed for CID ${cid}: ${error.message}`, error.name || '', error.cause || '');

    // Clean up the potentially partially downloaded file
    writeStream.close(() => {
        fsp.unlink(destinationPath).catch(unlinkErr => {
             if (unlinkErr.code !== 'ENOENT') {
                console.error(`[IPFS] Failed to delete partial download file ${destinationPath}:`, unlinkErr);
             }
        });
    });

    // Provide more specific error messages based on common IPFS errors
    if (error.message.includes("context deadline exceeded") || error.message.includes("request timed out") || error.name === 'TimeoutError') {
      throw new Error(`IPFS Download timed out for CID ${cid}. Check IPFS network connectivity or daemon status.`);
    } else if (error.message.includes("merkledag: not found")) {
      throw new Error(`IPFS CID not found: ${cid}`);
    } else {
      // General download failure
      throw new Error(`IPFS Download failed for CID ${cid}: ${error.message}`);
    }
  }
}

module.exports = {
  initializeIpfsClient,
  uploadToIpfsAndPin,
  downloadFromIpfs,
};