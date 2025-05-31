// encryption.js
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const config = require("../config");

const MASTER_KEY_BUFFER = Buffer.from(config.MASTER_ENCRYPTION_KEY_HEX, "hex");

/**
 * Encrypts data using the master AES-256-GCM key.
 * @param {Buffer} dataBuffer - The data to encrypt.
 * @returns {string} The encrypted payload as a hex string (IV + AuthTag + Ciphertext).
 * @throws {Error} If encryption fails or auth tag length is invalid.
 */
function encryptWithMasterKey(dataBuffer) {
  const iv = crypto.randomBytes(config.MASTER_KEY_IV_LENGTH);
  const cipher = crypto.createCipheriv(
    config.MASTER_KEY_ALGORITHM,
    MASTER_KEY_BUFFER,
    iv
  );

  const encryptedData = Buffer.concat([
    cipher.update(dataBuffer),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  if (authTag.length !== config.MASTER_KEY_AUTH_TAG_LENGTH) {
    // This should theoretically not happen with standard crypto library
    console.error(`[Encryption] Master Key Encryption: Invalid authTag length generated: ${authTag.length}`);
    throw new Error(`Master Key Encryption: Invalid authTag length ${authTag.length}`);
  }

  // Concatenate IV, AuthTag, and Encrypted Data
  const payload = Buffer.concat([iv, authTag, encryptedData]);

  // Return as hex string for easier storage/transmission
  return payload.toString("hex");
}

/**
 * Decrypts data encrypted with the master AES-256-GCM key.
 * @param {string} encryptedPayloadHex - The hex string containing IV + AuthTag + Ciphertext.
 * @returns {Buffer} The original decrypted data.
 * @throws {Error} If decryption fails (e.g., invalid key, corrupted data, wrong auth tag).
 */
function decryptWithMasterKey(encryptedPayloadHex) {
  try {
    const encryptedPayload = Buffer.from(encryptedPayloadHex, "hex");

    const iv = encryptedPayload.subarray(0, config.MASTER_KEY_IV_LENGTH);
    const authTag = encryptedPayload.subarray(
      config.MASTER_KEY_IV_LENGTH,
      config.MASTER_KEY_IV_LENGTH + config.MASTER_KEY_AUTH_TAG_LENGTH
    );
    const encryptedData = encryptedPayload.subarray(
      config.MASTER_KEY_IV_LENGTH + config.MASTER_KEY_AUTH_TAG_LENGTH
    );

    // Basic length checks before attempting decryption
    if (iv.length !== config.MASTER_KEY_IV_LENGTH) {
        throw new Error(`Invalid IV length (${iv.length}) during master key decryption`);
    }
    if (authTag.length !== config.MASTER_KEY_AUTH_TAG_LENGTH) {
        throw new Error(`Invalid AuthTag length (${authTag.length}) during master key decryption`);
    }
     if (encryptedData.length === 0 && encryptedPayload.length > (config.MASTER_KEY_IV_LENGTH + config.MASTER_KEY_AUTH_TAG_LENGTH)) {
        // Allows empty data encryption, but ensures data part isn't negative length
    } else if (encryptedData.length < 0) { // Should not happen with subarray logic, but safeguard
         throw new Error(`Invalid encrypted data length derived during master key decryption`);
    }


    const decipher = crypto.createDecipheriv(
      config.MASTER_KEY_ALGORITHM,
      MASTER_KEY_BUFFER,
      iv
    );
    decipher.setAuthTag(authTag);

    const decryptedData = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(), // This call verifies the AuthTag
    ]);

    return decryptedData;
  } catch (error) {
    // Log specific crypto errors if possible
    console.error(`[Encryption] Master key decryption failed: ${error.message}`, error.code || '');
    // Avoid leaking detailed crypto errors potentially, return a generic error
    throw new Error(`Master key decryption failed: ${error.name || "Decryption Error"}`);
  }
}

/**
 * Generates a new random AES key (32 bytes for AES-256).
 * @returns {Buffer} A 32-byte AES key.
 */
function generateAesKey() {
  return crypto.randomBytes(32); // 32 bytes = 256 bits
}

/**
 * Encrypts a file using AES-256-GCM with a provided key.
 * Prepends IV to the file, appends AuthTag.
 * @param {string} filePath - Path to the file to encrypt.
 * @param {Buffer} aesKey - The 32-byte AES key to use.
 * @returns {Promise<string>} Path to the encrypted file (original name + ".enc").
 * @throws {Error} If file reading, writing, or encryption fails.
 */
async function encryptBackupFile(filePath, aesKey) {
  const iv = crypto.randomBytes(config.MASTER_KEY_IV_LENGTH); // Use same IV length for consistency
  const cipher = crypto.createCipheriv(config.MASTER_KEY_ALGORITHM, aesKey, iv); // Use same algo

  const input = fs.createReadStream(filePath);
  const encryptedFilePath = `${filePath}.enc`;
  const output = fs.createWriteStream(encryptedFilePath);

  // Write the IV to the beginning of the output file
  output.write(iv);

  // Promise to handle stream piping and completion
  const streamPipe = new Promise((resolve, reject) => {
    input
      .pipe(cipher)
      .pipe(output)
      .on("finish", () => {
        // console.log(`[Encryption] Finished encrypting stream for ${path.basename(filePath)}`);
        resolve();
      })
      .on("error", (err) => {
        console.error(`[Encryption] Error during file encryption stream for ${filePath}:`, err);
        // Attempt cleanup of potentially partial encrypted file
        output.close(() => {
            fsp.unlink(encryptedFilePath).catch(unlinkErr => {
                 console.error(`[Encryption] Failed to delete partial encrypted file ${encryptedFilePath}:`, unlinkErr);
            });
        });
        reject(err);
      });
  });

  await streamPipe; // Wait for the encryption stream to finish

  // Get the authentication tag
  const authTag = cipher.getAuthTag();
  if (authTag.length !== config.MASTER_KEY_AUTH_TAG_LENGTH) {
      console.error(`[Encryption] File Encryption: Invalid authTag length generated: ${authTag.length}`);
      // Attempt cleanup
       fsp.unlink(encryptedFilePath).catch(unlinkErr => {});
      throw new Error(`File Encryption: Invalid authTag length ${authTag.length}`);
  }


  // Append the authentication tag to the end of the file
  // Use appendFile which handles opening/closing
  try {
      await fsp.appendFile(encryptedFilePath, authTag);
  } catch (appendError){
       console.error(`[Encryption] Failed to append auth tag to ${encryptedFilePath}:`, appendError);
        // Attempt cleanup
       fsp.unlink(encryptedFilePath).catch(unlinkErr => {});
       throw appendError; // Re-throw the error
  }

  // console.log(`[Encryption] Successfully encrypted ${path.basename(filePath)} to ${path.basename(encryptedFilePath)}`);
  return encryptedFilePath;
}

/**
 * Decrypts a file encrypted with encryptBackupFile using AES-256-GCM.
 * Reads IV from the beginning and AuthTag from the end.
 * @param {string} encryptedFilePath - Path to the encrypted file (.enc).
 * @param {Buffer} aesKey - The 32-byte AES key used for encryption.
 * @returns {Promise<string>} Path to the decrypted file (original name without .enc + ".decrypted.tar.gz").
 * @throws {Error} If file operations or decryption fail (e.g., wrong key, tampered file).
 */
async function decryptBackupFile(encryptedFilePath, aesKey) {
  const baseName = path.basename(encryptedFilePath, ".enc"); // Remove .enc extension
  // Ensure the decrypted file name indicates its temporary/intermediate nature
  const decryptedFilePath = path.join(
    path.dirname(encryptedFilePath),
    `${baseName}.decrypted.tar.gz` // Assume it's always tar.gz
  );

  let fd = null;
  try {
    fd = await fsp.open(encryptedFilePath, "r");
    const stats = await fd.stat();
    const totalSize = stats.size;

    // Basic size check: must be larger than IV + AuthTag
    if (totalSize < config.MASTER_KEY_IV_LENGTH + config.MASTER_KEY_AUTH_TAG_LENGTH) {
      throw new Error(`Encrypted file is too small (${totalSize} bytes) to contain IV and AuthTag.`);
    }

    // Read IV from the beginning
    const iv = Buffer.alloc(config.MASTER_KEY_IV_LENGTH);
    await fd.read(iv, 0, config.MASTER_KEY_IV_LENGTH, 0); // Read IV from position 0

    // Read AuthTag from the end
    const authTag = Buffer.alloc(config.MASTER_KEY_AUTH_TAG_LENGTH);
    const authTagPosition = totalSize - config.MASTER_KEY_AUTH_TAG_LENGTH;
    await fd.read(authTag, 0, config.MASTER_KEY_AUTH_TAG_LENGTH, authTagPosition); // Read AuthTag from the end

    // Setup decipher
    const decipher = crypto.createDecipheriv(config.MASTER_KEY_ALGORITHM, aesKey, iv);
    decipher.setAuthTag(authTag);

    // Create read stream for the encrypted data part (between IV and AuthTag)
    const encryptedDataStart = config.MASTER_KEY_IV_LENGTH;
    const encryptedDataEnd = totalSize - config.MASTER_KEY_AUTH_TAG_LENGTH - 1; // end is inclusive index

    if (encryptedDataStart > encryptedDataEnd + 1) {
        // This means the file ONLY contained IV and AuthTag, likely an empty file was encrypted
        // Create an empty decrypted file
        await fsp.writeFile(decryptedFilePath, '');
        // console.log(`[Encryption] Decrypted file ${encryptedFilePath} resulted in an empty file (was likely empty before encryption).`);
        return decryptedFilePath;
    }

    const input = fs.createReadStream(encryptedFilePath, {
      start: encryptedDataStart,
      end: encryptedDataEnd,
    });
    const output = fs.createWriteStream(decryptedFilePath);

    // Return a promise that resolves/rejects based on stream events
    return new Promise((resolve, reject) => {
      input
        .pipe(decipher)
        .pipe(output)
        .on("finish", () => {
          // console.log(`[Encryption] Successfully decrypted ${path.basename(encryptedFilePath)} to ${path.basename(decryptedFilePath)}`);
          resolve(decryptedFilePath);
        })
        .on("error", (err) => {
          console.error(`[Encryption] Error during file decryption stream for ${encryptedFilePath}:`, err.message);
          // Attempt cleanup of potentially partial decrypted file
          output.close(() => {
            fsp.unlink(decryptedFilePath).catch(unlinkErr => {
                if (unlinkErr.code !== 'ENOENT') { // Ignore if already deleted
                     console.error(`[Encryption] Failed to delete partial decrypted file ${decryptedFilePath}:`, unlinkErr);
                }
            });
          });
          // Provide a clearer error message for auth tag mismatch
          if (err.message.toLowerCase().includes('unsupported state') || err.message.toLowerCase().includes('authentication tag mismatch')) {
               reject(new Error(`Decryption failed: Authentication tag mismatch. File may be corrupt or wrong key used.`));
          } else {
              reject(new Error(`Decryption failed: ${err.message}`));
          }
        });
    });
  } finally {
    if (fd) {
      await fd.close().catch(closeErr => {
          console.error(`[Encryption] Error closing file descriptor for ${encryptedFilePath}:`, closeErr);
      });
    }
  }
}

module.exports = {
  encryptWithMasterKey,
  decryptWithMasterKey,
  generateAesKey,
  encryptBackupFile,
  decryptBackupFile,
};