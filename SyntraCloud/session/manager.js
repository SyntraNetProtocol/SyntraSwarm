// sessionManager.js - Index for session management modules

// Import functions from specific session modules
const { handleVerificationResult, handleTerminalRequest } = require("./lifecycle");
const { triggerBackup } = require("./backup");
const { initiateRecovery } = require("./recovery");
const { sendErrorAndCleanup, cleanupClientSession } = require("./cleanup");

// Re-export all imported functions to provide a single entry point
module.exports = {
  // Lifecycle functions
  handleVerificationResult,
  handleTerminalRequest,

  // Backup function
  triggerBackup,

  // Recovery function
  initiateRecovery,

  // Cleanup functions
  sendErrorAndCleanup,
  cleanupClientSession,
};

// This file is imported by:
// - websocketHandler.js (uses cleanupClientSession, initiateRecovery)
// - server.js (uses triggerBackup for periodic task, cleanupClientSession for shutdown)
// Other modules might import this if they need session functions.