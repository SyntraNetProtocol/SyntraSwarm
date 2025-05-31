// utils.js
const fsp = require("fs").promises;
const path = require("path");
const os = require("os");
const config = require("../config/index"); // Import config to potentially get TEMP_BACKUP_DIR if needed directly

/**
 * Generates a random ID with an optional prefix.
 * @param {string} [prefix='client'] - The prefix for the ID.
 * @returns {string} A unique ID string.
 */
function generateId(prefix = "client") {
  return `${prefix}-` + Math.random().toString(36).substring(2, 10);
}

/**
 * Parses resource values (RAM, CPU) from string format (e.g., "512Mi", "1Gi", "100m", "1c")
 * into a common numeric unit (MiB for RAM, millicores for CPU).
 * Handles potential suffixes and fractional values.
 * @param {string} valueStr - The resource string (e.g., "512Mi", "0.5c").
 * @returns {number} The parsed value in MiB or millicores, or 0 if invalid.
 */
function parseResourceValue(valueStr) {
  if (typeof valueStr !== "string" || !valueStr) return 0;

  // Handle potential edge case like "1.000" or "1,000" if needed, assuming '.' decimal separator
  const cleanedValueStr = valueStr.replace(',', '.');
  const value = parseFloat(cleanedValueStr);

  if (isNaN(value)) return 0;

  const lowerStr = cleanedValueStr.toLowerCase();

  if (lowerStr.endsWith("gi")) return Math.floor(value * 1024); // GiB to MiB
  if (lowerStr.endsWith("mi")) return Math.floor(value);         // MiB
  if (lowerStr.endsWith("ki")) return Math.floor(value / 1024); // KiB to MiB (often negligible but good to handle)

  // CPU specific units (millicores)
  if (lowerStr.endsWith("c") || /^\d+(\.\d+)?$/.test(cleanedValueStr)) { // Ends with 'c' or is just a number (assumed cores)
      return Math.floor(value * 1000); // Cores to millicores
  }
  if (lowerStr.endsWith("m")) return Math.floor(value);         // millicores

  // Default fallback if no recognized unit (might be bytes or other) - treat as base unit (MiB/m?)
  // Consider logging a warning here if unexpected units appear.
  // console.warn(`[parseResourceValue] Unrecognized unit in "${valueStr}", treating as base value.`);
  return Math.floor(value); // Default to MiB or millicores
}

/**
 * Ensures the temporary backup directory exists.
 * @throws {Error} If the directory cannot be created.
 */
async function ensureBackupDirExists() {
  try {
    await fsp.mkdir(config.TEMP_BACKUP_DIR, { recursive: true });
    // console.log(`[Utils] Ensured temporary backup directory exists: ${config.TEMP_BACKUP_DIR}`);
  } catch (error) {
    if (error.code !== "EEXIST") {
      console.error(`[Utils] Critical Error: Cannot create temporary backup directory at ${config.TEMP_BACKUP_DIR}`, error);
      throw new Error(`Cannot create backup dir: ${error.message}`);
    }
    // If EEXIST, directory already exists, which is fine.
  }
}


module.exports = {
  generateId,
  parseResourceValue,
  ensureBackupDirExists,
};