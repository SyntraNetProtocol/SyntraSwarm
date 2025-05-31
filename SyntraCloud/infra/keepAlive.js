// keepAlive.js
const WebSocket = require("ws");
const config = require("../config/index");
const state = require("../state");
const sessionManager = require("../session/manager"); // For cleanupClientSession
// const dashboardService = require("./dashboardService"); // For cleanup?

/**
 * Starts the interval timer to check WebSocket connections (clients, contributors, dashboards)
 * using ping/pong mechanism and terminates unresponsive connections.
 */
function startKeepAlive() {
  // Clear existing interval if any
  if (state.getKeepAliveInterval()) {
    console.log("[KeepAlive] Clearing existing keep-alive interval.");
    clearInterval(state.getKeepAliveInterval());
    state.setKeepAliveInterval(null);
  }

  console.log(`[KeepAlive] Starting keep-alive check interval (${config.CLIENT_TIMEOUT_MS}ms timeout / ${config.PING_INTERVAL_MS}ms ping interval).`);

  const intervalId = setInterval(() => {
    // console.log("[KeepAlive] Performing keep-alive check...");

    // --- Check Client Sessions ---
    state.clientSessions.forEach((session, clientId) => {
      if (!session.ws) {
          console.warn(`[KeepAlive] Client ${clientId} has no WebSocket object in state. Skipping check.`);
          // Consider cleanup if WS is missing but session exists? Or let other logic handle it.
          return;
      }

      // isAlive flag is set to true on pong/message, reset to false before ping
      if (session.isAlive === false) {
        // Client did not respond to the previous ping within the timeout period
        console.warn(`[KeepAlive] Client ${clientId} timed out (no pong received). Terminating connection.`);
        session.ws.terminate(); // Forcefully close the connection
        // Cleanup will be triggered by the 'close' event handler in websocketHandler
        return; // Move to the next client
      }

      // Reset liveness flag and send a ping
      session.isAlive = false;
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.ping((err) => {
          if (err) {
            console.error(`[KeepAlive] Error sending ping to client ${clientId}: ${err.message}. Terminating.`);
            session.ws.terminate(); // Terminate on ping send error
             // Cleanup triggered by 'close' event
          } else {
            // console.log(`[KeepAlive] Sent ping to client ${clientId}`);
          }
        });
      } else {
          // console.log(`[KeepAlive] Client ${clientId} WebSocket not open (State: ${session.ws.readyState}). Skipping ping.`);
          // If not OPEN, it might be closing or closed. Terminate if stuck?
          if(session.ws.readyState === WebSocket.CONNECTING || session.ws.readyState === WebSocket.CLOSING){
              console.warn(`[KeepAlive] Client ${clientId} stuck in ${session.ws.readyState} state. Terminating.`);
              session.ws.terminate();
          }
          // Let the close handler manage cleanup otherwise.
      }
    });

    // --- Check Contributor Nodes ---
    state.contributorNodes.forEach((nodeInfo, nodeId) => {
        if (!nodeInfo.ws) {
            console.warn(`[KeepAlive] Contributor ${nodeId} has no WebSocket object in state. Skipping check.`);
            // Node might have disconnected cleanly.
            return;
        }

        if (nodeInfo.isAlive === false) {
            console.warn(`[KeepAlive] Contributor node ${nodeId} timed out (no pong received). Terminating connection.`);
            nodeInfo.ws.terminate();
             // Cleanup (including recovery initiation) triggered by 'close' event
            return;
        }

        nodeInfo.isAlive = false;
         if (nodeInfo.ws.readyState === WebSocket.OPEN) {
            nodeInfo.ws.ping((err) => {
                if (err) {
                    console.error(`[KeepAlive] Error sending ping to contributor ${nodeId}: ${err.message}. Terminating.`);
                    nodeInfo.ws.terminate();
                } else {
                    // console.log(`[KeepAlive] Sent ping to contributor ${nodeId}`);
                }
            });
        } else {
            // console.log(`[KeepAlive] Contributor ${nodeId} WebSocket not open (State: ${nodeInfo.ws.readyState}). Skipping ping.`);
             if(nodeInfo.ws.readyState === WebSocket.CONNECTING || nodeInfo.ws.readyState === WebSocket.CLOSING){
                 console.warn(`[KeepAlive] Contributor ${nodeId} stuck in ${nodeInfo.ws.readyState} state. Terminating.`);
                 nodeInfo.ws.terminate();
             }
        }
    });

    // --- Check Dashboard Sockets ---
    state.dashboardSockets.forEach((dashInfo, dashId) => {
         if (!dashInfo.ws) {
             console.warn(`[KeepAlive] Dashboard ${dashId} has no WebSocket object in state. Skipping check.`);
             return;
         }

        if (dashInfo.isAlive === false) {
            console.warn(`[KeepAlive] Dashboard client ${dashId} timed out (no pong received). Terminating connection.`);
            dashInfo.ws.terminate();
            // Cleanup triggered by 'close' event
            return;
        }

        dashInfo.isAlive = false;
         if (dashInfo.ws.readyState === WebSocket.OPEN) {
            dashInfo.ws.ping((err) => {
                if (err) {
                    console.error(`[KeepAlive] Error sending ping to dashboard ${dashId}: ${err.message}. Terminating.`);
                    dashInfo.ws.terminate();
                } else {
                    // console.log(`[KeepAlive] Sent ping to dashboard ${dashId}`);
                }
            });
        } else {
            // console.log(`[KeepAlive] Dashboard ${dashId} WebSocket not open (State: ${dashInfo.ws.readyState}). Skipping ping.`);
             if(dashInfo.ws.readyState === WebSocket.CONNECTING || dashInfo.ws.readyState === WebSocket.CLOSING){
                 console.warn(`[KeepAlive] Dashboard ${dashId} stuck in ${dashInfo.ws.readyState} state. Terminating.`);
                 dashInfo.ws.terminate();
             }
        }
    });

  }, config.PING_INTERVAL_MS); // Run the check based on the PING interval

  state.setKeepAliveInterval(intervalId); // Store the interval ID
}

/**
 * Stops the keep-alive interval timer.
 */
function stopKeepAlive() {
  const intervalId = state.getKeepAliveInterval();
  if (intervalId) {
    console.log("[KeepAlive] Stopping keep-alive check interval.");
    clearInterval(intervalId);
    state.setKeepAliveInterval(null);
  } else {
    // console.log("[KeepAlive] Keep-alive interval already stopped.");
  }
}

module.exports = {
  startKeepAlive,
  stopKeepAlive,
};