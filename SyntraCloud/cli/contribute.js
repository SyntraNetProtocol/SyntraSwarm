// =========================== FILE: cli-contribute.js ===========================
// TUI Version using Blessed
// ===============================================================================

const WebSocket = require("ws");
const os = require("os");
const process = require("process");
const axios = require("axios");
const blessed = require("blessed"); // Importa blessed

// --- Initial Config from Args (can be overridden later) ---
const serverWsUrl = process.argv[2] || "ws://localhost:5501";
const initialMetadataURI =
  process.argv[3] || `https://node.local/${os.hostname()}`;
const initialTotalRamInput = process.argv[4] || "512"; // Default più ragionevole
const initialTotalCpuInput = process.argv[5] || "500"; // Default più ragionevole (0.5c)
const initialTotalStorageInput = process.argv[6] || "10";
let usernameCLI = process.argv[7] || "";
let passwordCLI = process.argv[8] || "";
let providerAddressCLI = process.argv[9] || "";
let initialFhePubKeyRef =
  process.argv[10] || `ipfs://placeholder-pub-${os.hostname()}`;
let initialFheEvalKeyRef =
  process.argv[11] || `ipfs://placeholder-eval-${os.hostname()}`;

// --- Global State ---
let ws;
let heartbeatInterval = null;
let reconnectTimeout = null;
let nodeId =
  os.hostname() || `contributor-${Math.random().toString(16).slice(2, 8)}`;
let lastHeartbeatAck = null;
let wsStatus = "Disconnected";

// --- DLT Config ---
const DLT_CALL_ENDPOINT =
  process.env.DLT_CALL_ENDPOINT ||
  "http://localhost:4004/ZKAASyntraCallStripe2";
const CONTRACT_NAME = process.env.CONTRACT_NAME || "SyntraNetV3";
const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS || "0x8c04b4B2db4bC0C6862f9d4543Bf5D3eDACfAF25";

// --- Helper Functions ---
let apiHttpBaseUrl;
try {
  const wsUrlParsed = new URL(serverWsUrl);
  const httpProtocol = wsUrlParsed.protocol === "wss:" ? "https:" : "http:";
  apiHttpBaseUrl = `${httpProtocol}//${wsUrlParsed.host}`;
} catch (e) {
  console.error("Invalid WebSocket URL.");
  process.exit(1);
}
const statusEndpointUrl = `${apiHttpBaseUrl}/status`;

function parseValueForContract(valueStr, targetUnit = "milli") {
  if (typeof valueStr !== "string" || !valueStr) return 0;
  const value = parseFloat(valueStr);
  if (isNaN(value)) return 0;
  const lowerStr = valueStr.toLowerCase();
  if (targetUnit === "milli") {
    // CPU
    if (lowerStr.endsWith("c") || /^\d+(\.\d+)?$/.test(valueStr))
      return Math.floor(value * 1000);
    if (lowerStr.endsWith("m")) return Math.floor(value);
    return Math.floor(value * 1000); // Assume cores if no unit
  }
  if (targetUnit === "mebi") {
    // RAM
    if (lowerStr.endsWith("gi")) return Math.floor(value * 1024);
    if (lowerStr.endsWith("mi")) return Math.floor(value);
    if (lowerStr.endsWith("ki")) return Math.floor(value / 1024);
    return Math.floor(value); // Assume MiB if no unit
  }
  if (targetUnit === "gibi") {
    // Storage
    if (lowerStr.endsWith("gi")) return Math.floor(value);
    if (lowerStr.endsWith("ti")) return Math.floor(value * 1024);
    if (lowerStr.endsWith("mi")) return Math.floor(value / 1024);
    return Math.floor(value); // Assume GiB if no unit
  }
  return Math.floor(value);
}

// --- Blessed UI Setup ---
const screen = blessed.screen({
  smartCSR: true,
  title: "SyntraNet Contributor Node",
  fullUnicode: true, // Supporta caratteri unicode
});

// Layout Box
const layout = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
});

// Status Bar at the top
const statusBar = blessed.box({
  parent: layout,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { bg: "blue", fg: "white" },
  content: ` WS: ${wsStatus} | Node ID: ${nodeId} | Contract: ${CONTRACT_ADDRESS.substring(0, 10)}...`,
});

// Main Info Box
const infoBox = blessed.box({
  parent: layout,
  top: 1,
  left: 0,
  width: "50%",
  height: "50%-1",
  label: " Node Info ",
  border: "line",
  style: { border: { fg: "cyan" } },
  tags: true, // Enable tags for colors/formatting
});

// Menu Box
const menuBox = blessed.listbar({
  // Using listbar for a simple horizontal menu
  parent: layout,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  border: "line",
  label: " Actions ",
  keys: true,
  mouse: true, // Enable key/mouse navigation
  style: {
    border: { fg: "green" },
    item: { fg: "white", bg: "black" },
    selected: { fg: "black", bg: "green" },
  },
  commands: {
    // Define menu items
    "Register Node On-Chain": {
      keys: ["r"],
      callback: () => promptAndRegisterNode(),
    },
    "Show Network Dashboard": {
      keys: ["d"],
      callback: () => fetchAndDisplayDashboardData(),
    },
    "Reconnect WS": {
      keys: ["c"],
      callback: () => {
        if (ws) ws.close(1000);
        connect();
      },
    },
    Exit: { keys: ["q", "escape"], callback: () => shutdown() },
  },
});

// Log Box
const logBox = blessed.log({
  parent: layout,
  top: 1,
  right: 0,
  width: "50%",
  height: "100%-3", // Adjusted height
  label: " Logs ",
  border: "line",
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: " ", track: { bg: "grey" }, style: { bg: "cyan" } },
  keys: true,
  mouse: true, // Enable scrolling
  style: { border: { fg: "yellow" } },
});

// --- UI Update Functions ---
function updateStatusBar() {
  statusBar.setContent(
    ` WS: {bold}${wsStatus}{/bold} | Node ID: ${nodeId} | Last ACK: ${lastHeartbeatAck ? new Date(lastHeartbeatAck).toLocaleTimeString() : "N/A"} | Contract: ${CONTRACT_ADDRESS.substring(0, 10)}...`,
  );
  screen.render();
}

function updateInfoBox() {
  const ramAdvertised = parseValueForContract(initialTotalRamInput, "mebi");
  const cpuAdvertised = parseValueForContract(initialTotalCpuInput, "milli");
  const storageAdvertised = parseValueForContract(
    initialTotalStorageInput,
    "gibi",
  );

  let content = `{cyan-fg}Provider Address:{/} ${providerAddressCLI || "{yellow-fg}Not Set (use args/login){/}"}\n`;
  content += `{cyan-fg}Metadata URI:{/} ${initialMetadataURI}\n`;
  content += `{cyan-fg}FHE PubKey Ref:{/} ${initialFhePubKeyRef}\n`;
  content += `{cyan-fg}FHE EvalKey Ref:{/} ${initialFheEvalKeyRef}\n\n`;
  content += `{cyan-fg}Advertised Resources:{/}\n`;
  content += `  RAM: {bold}${ramAdvertised} MiB{/bold}\n`;
  content += `  CPU: {bold}${cpuAdvertised} m{/bold}\n`;
  content += `  Storage: {bold}${storageAdvertised} GiB{/bold}\n\n`;
  content += `{cyan-fg}DLT Endpoint:{/} ${DLT_CALL_ENDPOINT}`;

  infoBox.setContent(content);
  screen.render();
}

function logMessage(msg, level = "info") {
  let prefix = "{blue-fg}[INFO]{/}";
  if (level === "error") prefix = "{red-fg}[ERROR]{/}";
  if (level === "warn") prefix = "{yellow-fg}[WARN]{/}";
  if (level === "success") prefix = "{green-fg}[SUCCESS]{/}";
  if (level === "ws") prefix = "{magenta-fg}[WS]{/}";
  if (level === "dlt") prefix = "{cyan-fg}[DLT]{/}";

  logBox.log(`${prefix} ${msg}`); // Use log method for scrolling
  // screen.render(); // Rendering is handled centrally or after major updates
}

// --- WebSocket Logic ---
function connect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (
    ws &&
    (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)
  ) {
    logMessage("Already connected or connecting.", "warn");
    return;
  }

  wsStatus = "Connecting";
  logMessage(`Attempting connection to ${serverWsUrl}...`, "ws");
  updateStatusBar();

  // Update initial resources based on current inputs before connecting
  const currentRamMb = parseValueForContract(initialTotalRamInput, "mebi");
  const currentCpuM = parseValueForContract(initialTotalCpuInput, "milli");
  const currentStorageGb = parseValueForContract(
    initialTotalStorageInput,
    "gibi",
  );

  ws = new WebSocket(serverWsUrl);

  ws.on("open", () => {
    wsStatus = "Connected";
    lastHeartbeatAck = Date.now();
    logMessage("Connected. Registering presence...", "ws");
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = null; // Clear retry timer on successful connect

    const msg = {
      type: "register_contributor",
      nodeId: nodeId, // Use the current nodeId
      totalRam: `${currentRamMb}Mi`, // Send parsed values
      totalCpu: `${currentCpuM}m`,
      totalStorage: `${currentStorageGb}Gi`,
      providerAddress: providerAddressCLI || null,
      fhePublicKeyRef: initialFhePubKeyRef,
      fheEvaluationKeyRef: initialFheEvalKeyRef,
    };
    ws.send(JSON.stringify(msg));
    logMessage(
      `Sent registration: RAM=${currentRamMb}Mi, CPU=${currentCpuM}m, Storage=${currentStorageGb}Gi`,
      "info",
    );

    // Start heartbeat
    heartbeatInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
        // logMessage('Sent heartbeat', 'debug'); // Optional: verbose logging
      } else {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }
    }, 300000000); // 30 seconds
    updateStatusBar();
    updateInfoBox(); // Update info box with initial values
  });

  ws.on("message", async (data) => {
    lastHeartbeatAck = Date.now(); // Assume any message means connection is alive
    updateStatusBar(); // Update last ACK time

    const dataStr = data.toString();
    try {
      const msgObj = JSON.parse(dataStr);
      if (msgObj.type === "ack_register") {
        if (msgObj.status === "success" && msgObj.nodeId) {
          nodeId = msgObj.nodeId; // Update nodeId if server assigns a new one
          wsStatus = "Registered";
          logMessage(
            `Registration Acknowledged. Node ID: ${nodeId}`,
            "success",
          );
          updateStatusBar();
        } else {
          logMessage(
            `Registration Ack failed: ${msgObj.message || "Unknown reason"}`,
            "warn",
          );
        }
      } else if (msgObj.type === "heartbeat_ack") {
        // Already handled by updating lastHeartbeatAck
        // logMessage('Heartbeat ACK received', 'debug'); // Optional
      } else {
        // Log other messages from server
        logMessage(`Server: ${JSON.stringify(msgObj)}`, "ws");
      }
    } catch (e) {
      logMessage(`Non-JSON received: ${dataStr.substring(0, 80)}...`, "warn");
    }
  });

  ws.on("close", (code, reason) => {
    wsStatus = "Disconnected";
    logMessage(
      `Connection closed. Code: ${code}, Reason: ${reason || "N/A"}`,
      "ws",
    );
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    ws = null;
    updateStatusBar();
    // Attempt to reconnect only if the closure was unexpected
    if (code !== 1000 && code !== 1001 && !reconnectTimeout) {
      logMessage("Attempting reconnect in 10s...", "warn");
      reconnectTimeout = setTimeout(connect, 10000);
    }
  });

  ws.on("error", (err) => {
    wsStatus = "Error";
    logMessage(`WebSocket error: ${err.message}`, "error");
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    ws?.terminate(); // Force close on error
    ws = null;
    updateStatusBar();
    // Schedule reconnect on error
    if (!reconnectTimeout) {
      const retryDelay = 15000;
      logMessage(`Attempting reconnect in ${retryDelay / 1000}s...`, "warn");
      reconnectTimeout = setTimeout(connect, retryDelay);
    }
  });
}

// --- Action Functions ---

// Helper for interactive prompts using blessed
function promptInput(label, defaultValue = "", callback) {
  const promptDialog = blessed.prompt({
    parent: screen,
    top: "center",
    left: "center",
    height: "shrink",
    width: "50%",
    label: ` ${label} `,
    border: "line",
    style: { fg: "white", bg: "blue", border: { fg: "white" } },
  });
  promptDialog.input(label, defaultValue, (err, value) => {
    if (err) {
      logMessage(`Prompt error: ${err.message}`, "error");
      callback(null); // Indicate error or cancellation
    } else if (value === null) {
      logMessage("Prompt cancelled.", "info");
      callback(null); // Indicate cancellation
    } else {
      callback(value); // Return the entered value
    }
    screen.render(); // Re-render after prompt closes
  });
}

// Helper to chain multiple prompts
async function getInputsViaPrompts(prompts) {
  const results = {};
  for (const p of prompts) {
    const value = await new Promise((resolve) => {
      promptInput(p.label, p.default, resolve);
    });
    if (value === null) return null; // User cancelled
    results[p.key] = value;
  }
  return results;
}

// Function to ask for credentials if needed
async function ensureCredentials() {
  if (!usernameCLI || !passwordCLI) {
    logMessage("ZK-Auth Username/Password needed.", "info");
    const creds = await getInputsViaPrompts([
      {
        key: "username",
        label: "Enter ZK-Auth Username:",
        default: usernameCLI,
      },
      { key: "password", label: "Enter ZK-Auth Password:", default: "" }, // Password shouldn't have default shown
    ]);
    if (!creds) return false; // User cancelled
    usernameCLI = creds.username;
    passwordCLI = creds.password;
    // Auto-fill provider address if username looks like one
    if (
      !providerAddressCLI &&
      usernameCLI &&
      usernameCLI.startsWith("0x") &&
      usernameCLI.length === 42
    ) {
      providerAddressCLI = usernameCLI;
      logMessage(
        `Provider address set to username: ${providerAddressCLI}`,
        "info",
      );
      updateInfoBox(); // Update UI
    }
  }
  return true; // Credentials are now available
}

async function promptAndRegisterNode() {
  logMessage("Starting on-chain registration process...", "info");
  if (!(await ensureCredentials())) return; // Get credentials first

  const prompts = [
    {
      key: "cpu",
      label: "CPU to register (e.g., 500m or 1c):",
      default: initialTotalCpuInput,
    },
    {
      key: "ram",
      label: "RAM to register (e.g., 512Mi or 1Gi):",
      default: initialTotalRamInput,
    },
    {
      key: "storage",
      label: "Storage to register (e.g., 10Gi):",
      default: initialTotalStorageInput,
    },
    { key: "metadata", label: "Metadata URI:", default: initialMetadataURI },
    {
      key: "fhePub",
      label: "FHE Public Key Ref:",
      default: initialFhePubKeyRef,
    },
    {
      key: "fheEval",
      label: "FHE Evaluation Key Ref:",
      default: initialFheEvalKeyRef,
    },
  ];

  const inputs = await getInputsViaPrompts(prompts);
  if (!inputs) {
    logMessage("On-chain registration cancelled.", "info");
    return;
  }

  const regCpu = parseValueForContract(inputs.cpu, "milli");
  const regRam = parseValueForContract(inputs.ram, "mebi");
  const regStorage = parseValueForContract(inputs.storage, "gibi");

  if (regCpu === 0 || regRam === 0) {
    logMessage("Invalid CPU or RAM values entered for registration.", "error");
    return;
  }

  logMessage(
    `Registering with: CPU=${regCpu}m, RAM=${regRam}Mi, Storage=${regStorage}Gi`,
    "dlt",
  );

  try {
    const url = DLT_CALL_ENDPOINT;
    const method = "registerNode";
    const args = [
      inputs.metadata,
      String(regCpu),
      String(regRam),
      String(regStorage),
      inputs.fhePub,
      inputs.fheEval,
    ];
    const body = {
      username: usernameCLI,
      password: passwordCLI,
      contractName: CONTRACT_NAME,
      contractAddress: CONTRACT_ADDRESS,
      method: method,
      args: args,
    };

    logMessage(`Sending registration request to ${url}...`, "dlt");
    screen.render(); // Update screen before potentially long request

    const resp = await axios.post(url, body, {
      headers: {
        "Content-Type": "application/json",
        "bypass-tunnel-reminder": "true",
      },
      timeout: 90000, // Increased timeout for blockchain interaction
    });

    const respData = resp.data;
    logMessage(`Registration Response: ${JSON.stringify(respData)}`, "dlt");

    if (
      respData &&
      (respData.success === true || respData.transactionHash || respData.result)
    ) {
      logMessage("On-chain node registration successful/submitted.", "success");
    } else {
      logMessage(
        `On-chain registration status uncertain. ${respData?.error || respData?.message || ""}`,
        "warn",
      );
    }
  } catch (err) {
    const errMsg =
      err.response?.data?.error ||
      err.response?.data?.details ||
      err.response?.data?.message ||
      err.message;
    logMessage(`On-chain registration failed: ${errMsg}`, "error");
  } finally {
    screen.render(); // Ensure screen updates after async op
  }
}

async function fetchAndDisplayDashboardData() {
  logMessage("Fetching network dashboard data...", "info");
  try {
    const response = await axios.get(statusEndpointUrl, { timeout: 10000 });
    const data = response.data;
    if (!data || !data.summary || !data.contributors || !data.clients) {
      logMessage("Incomplete dashboard data received.", "warn");
      return;
    }

    logMessage("--- Network Summary ---", "info");
    logBox.log(JSON.stringify(data.summary, null, 2)); // Simple JSON log for now

    logMessage("\n--- Contributors ---", "info");
    if (data.contributors.length > 0) {
      data.contributors.forEach((c) => {
        logBox.log(
          `  ID: ${c.id}, Conn: ${c.connected}, Addr: ${c.address?.substring(0, 10)}..., RAM: ${c.totalRam} (Avail: ${c.availableRam}), CPU: ${c.totalCpu} (Avail: ${c.availableCpu}), Terms: ${c.activeTerminalsCount}, Seen: ${c.lastSeenAgo}`,
        );
      });
    } else {
      logMessage("  No contributors connected.", "info");
    }

    logMessage("\n--- Client Sessions ---", "info");
    if (data.clients.length > 0) {
      data.clients.forEach((c) => {
        logBox.log(
          `  ID: ${c.id}, Conn: ${c.connected}, Status: ${c.status}, User: ${c.userAddress?.substring(0, 10)}..., Host: ${c.contributorId || "N/A"}, Pod: ${c.podName || "N/A"}`,
        );
      });
    } else {
      logMessage("  No active client sessions.", "info");
    }
  } catch (error) {
    logMessage(
      `Error fetching dashboard data: ${error.response?.data || error.message}`,
      "error",
    );
  } finally {
    screen.render();
  }
}

function shutdown() {
  logMessage("Shutting down...", "info");
  screen.render(); // Show shutdown message
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (ws) ws.close(1000, "Contributor CLI shutting down");

  // Give blessed a moment to render the final message before destroying
  setTimeout(() => {
    screen.destroy(); // Restore terminal
    console.log("Contributor CLI exited.");
    process.exit(0);
  }, 300);
}

// --- Initial Setup & Start ---
screen.key(["escape", "q", "C-c"], shutdown); // Global exit keys

// Render the initial UI
updateStatusBar();
updateInfoBox();
screen.render();
menuBox.focus(); // Focus the menu bar initially

// Start the connection
connect();

// Handle potential uncaught errors
process.on("uncaughtException", (error) => {
  // Try to log to blessed screen if possible, otherwise console
  try {
    logMessage(`UNCAUGHT EXCEPTION: ${error.stack || error.message}`, "error");
    screen.render();
  } catch (e) {
    console.error("UNCAUGHT EXCEPTION (Blessed failed):", error);
  }
  // Optional: attempt a graceful shutdown or just exit
  // shutdown(); // Careful with async operations here
  // process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  try {
    logMessage(`UNHANDLED REJECTION: ${reason}`, "error");
    screen.render();
  } catch (e) {
    console.error("UNHANDLED REJECTION (Blessed failed):", reason);
  }
});
