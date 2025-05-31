// config.js
require("dotenv").config();
const os = require("os");
const path = require("path");

const TEMP_BACKUP_DIR = path.join(os.tmpdir(), "syntra_backups");

module.exports = {
  PORT: process.env.PORT || 5501,
  BASE_URL: process.env.BASE_URL || "https://syntraconnectdev.loca.lt",
  CONTRACT_NAME: "SyntraNetPodV2",
  CONTRACT_ADDRESS:
    process.env.CONTRACT_ADDRESS || "0x8c04b4B2db4bC0C6862f9d4543Bf5D3eDACfAF25",
  DLT_API_ENDPOINT: `${process.env.BASE_URL || "https://syntraconnectdev.loca.lt"}/ZKAASyntraCallStripe2`,
  AUTH_API_ENDPOINT: `${process.env.BASE_URL || "https://syntraconnectdev.loca.lt"}/login`,
  BACKUP_INTERVAL_MS: 15 * 60 * 1000, // 15 minutes
  TEMP_BACKUP_DIR: TEMP_BACKUP_DIR,
  K8S_NAMESPACE: process.env.K8S_NAMESPACE || "syntracloud",
  POD_BACKUP_TARGET_PATH: process.env.POD_BACKUP_TARGET_PATH || "/data",
  POD_RESTORE_TARGET_PATH: process.env.POD_RESTORE_TARGET_PATH || "/",
  IPFS_API_URL: process.env.IPFS_API_URL || "http://127.0.0.1:5001",

  MASTER_ENCRYPTION_KEY_HEX: process.env.MASTER_ENCRYPTION_KEY,
  MASTER_KEY_ALGORITHM: "aes-256-gcm",
  MASTER_KEY_IV_LENGTH: 12,
  MASTER_KEY_AUTH_TAG_LENGTH: 16,

  DASHBOARD_UPDATE_INTERVAL_MS: 5000, // 5 seconds
  PING_INTERVAL_MS: 300000000, // 30 seconds (Original was 300001000, seems like a typo)
  CLIENT_TIMEOUT_MS: (300000000 * 2) + 1000, // PING_INTERVAL_MS * 2 + grace period (Adjusted from original potentially typo value)
};

// Check for mandatory config
if (!module.exports.MASTER_ENCRYPTION_KEY_HEX) {
  console.error("FATAL ERROR: MASTER_ENCRYPTION_KEY environment variable is not set.");
  process.exit(1);
}
if (module.exports.MASTER_ENCRYPTION_KEY_HEX.length !== 64) {
    console.error("FATAL ERROR: MASTER_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
    process.exit(1);
}
