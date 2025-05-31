require("dotenv").config();
const http = require("http");
const { exec } = require("child_process");
const config = require("./SyntraCloud/config");
const state = require("./SyntraCloud/state");
const express = require("express");
const cors = require("cors");
const path = require("path");
const utils = require("./SyntraCloud/utils");
// const ipfsService = require("./SyntraCloud/services/ipfsService"); 
const dashboardService = require("./SyntraCloud/services/dashboardService");
const keepAlive = require("./SyntraCloud/infra/keepAlive");
const sessionManager = require("./SyntraCloud/session/manager");
const websocketHandler = require("./SyntraCloud/network/websocketHandler");
const k8sPodLifecycle = require("./SyntraCloud/infra/kubernetes/podLifecycle");

const app = express();

let context = {};

function initializeContext(modules) {
  Object.assign(context, modules);
}

app.use(cors());
app.use(express.json());

let server;
let backupIntervalId = null;
let dashboardIntervalId = null;

function performCleanup(clientId, reason) {
  if (context.state && context.state.clientSessions && context.state.clientSessions.has(clientId)) {
    const session = context.state.clientSessions.get(clientId);
    if (session.contributorWs) {
      try {
        session.contributorWs.close(1000, `Cleanup: ${reason}`);
      } catch (error) {
        
      }
    }
    if (context.k8sPodLifecycle && typeof context.k8sPodLifecycle.terminatePod === 'function' && session.podName) {
      context.k8sPodLifecycle.terminatePod(session.podName, session.namespace).catch(err => {
        console.error(`[Server] Errore durante la terminazione del pod ${session.podName} tramite k8sPodLifecycle: ${err.message}`);
      });
    } else if (session.podName) {
      console.warn(`[Server] Impossibile terminare pod ${session.podName} per cleanup: k8sPodLifecycle non disponibile o mancante funzione terminatePod.`);
    }
    context.state.clientSessions.delete(clientId);
  } else {
    console.warn(`[Server] Cleanup richiesto per sessione ${clientId}, ma non trovata nello stato.`);
  }
}

async function runInitialChecks() {
  let checksPassed = true;

  if (!context.config) {
    console.error("[Server] ERRORE FATALE: Contesto non completamente inizializzato. Manca 'config'.");
    process.exit(1);
  }

  try {
    await new Promise((resolve, reject) => {
      exec(`kubectl version --client`, { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Controllo client kubectl fallito: ${stderr || err.message}`));
        resolve();
      });
    });
  } catch (k8sClientErr) {
    console.error(`[Server] ERRORE FATALE: ${k8sClientErr.message}`);
    checksPassed = false;
  }

  try {
    await new Promise((resolve, reject) => {
      exec(`kubectl get namespace ${context.config.K8S_NAMESPACE} -o name`, { timeout: 5000 }, (err, stdout, stderr) => {
        if (err || !stdout || !stdout.trim().includes(`namespace/${context.config.K8S_NAMESPACE}`)) {
          return reject(new Error(`Namespace Kubernetes '${context.config.K8S_NAMESPACE}' non trovato o inaccessibile: ${stderr || err?.message || "Non trovato"}`));
        }
        resolve();
      });
    });
  } catch (k8sNsErr) {
    console.error(`[Server] ERRORE FATALE: ${k8sNsErr.message}`);
    checksPassed = false;
  }

  if (!context.utils || typeof context.utils.ensureBackupDirExists !== 'function') {
    console.error("[Server] ERRORE FATALE: Contesto non completamente inizializzato. Manca 'utils' o la sua funzione 'ensureBackupDirExists'.");
    checksPassed = false;
  } else {
    try {
      await context.utils.ensureBackupDirExists();
    } catch (dirErr) {
      console.error(`[Server] ERRORE FATALE: Impossibile assicurare l'esistenza della directory di backup temporanea.`, dirErr.message);
      checksPassed = false;
    }
  }

  if (!checksPassed) {
    console.error("[Server] Controlli iniziali falliti. Uscita dall'applicazione.");
    process.exit(1);
  }
}

function startPeriodicTasks() {
  if (!context.config || !context.state || !context.sessionManager || !context.dashboardService) {
    console.error("[Server] ERRORE: Impossibile avviare task periodici. Contesto incompleto.");
    return;
  }

  if (backupIntervalId) clearInterval(backupIntervalId);
  backupIntervalId = setInterval(() => {
    if (!context.state || !context.state.clientSessions) {
      console.error("[Server][BackupTask] Errore: state o clientSessions non definiti nel contesto.");
      return;
    }
    const activeClients = Array.from(context.state.clientSessions.values()).filter(
      (session) => session.status === "active" && !session.backupInProgress
    );
    if (activeClients.length > 0) {
      if (!context.sessionManager || typeof context.sessionManager.triggerBackup !== 'function') {
        console.error("[Server][BackupTask] Errore: sessionManager o la sua funzione triggerBackup non definiti nel contesto.");
        return;
      }
      activeClients.forEach((session) => {
        // Qui potresti dover verificare se il backup richiede IPFS e saltarlo se non disponibile
        context.sessionManager.triggerBackup(session.id).catch(err => {
          console.error(`[Server][BackupTask] Errore nell'attivare il backup per ${session.id}: ${err.message}`);
        });
      });
    }
  }, context.config.BACKUP_INTERVAL_MS);

  if (dashboardIntervalId) clearInterval(dashboardIntervalId);
  if (!context.dashboardService || typeof context.dashboardService.broadcastDashboardUpdate !== 'function') {
    console.error("[Server][DashboardTask] Errore: dashboardService o la sua funzione broadcastDashboardUpdate non definiti nel contesto. Dashboard updates non avviati.");
  } else {
    dashboardIntervalId = setInterval(context.dashboardService.broadcastDashboardUpdate, context.config.DASHBOARD_UPDATE_INTERVAL_MS);
  }

  if (keepAlive && typeof keepAlive.startKeepAlive === 'function') {
    keepAlive.startKeepAlive();
  } else {
    console.warn("[Server] Avviso: Keep-alive non disponibile o non correttamente importato.");
  }
}

function stopPeriodicTasks() {
  if (backupIntervalId) {
    clearInterval(backupIntervalId);
    backupIntervalId = null;
  }
  if (dashboardIntervalId) {
    clearInterval(dashboardIntervalId);
    dashboardIntervalId = null;
  }
  if (keepAlive && typeof keepAlive.stopKeepAlive === 'function') {
    keepAlive.stopKeepAlive();
  } else {
    console.warn("[Server] Avviso: Impossibile arrestare keep-alive (non disponibile).");
  }
}

async function initializeApp() {
  initializeContext({
    config,
    state,
    utils,
    // ipfsService, // Includi solo se ancora usato opzionalmente
    dashboardService,
    sessionManager,
    websocketHandler,
    k8sPodLifecycle,
  });

  await runInitialChecks();

  app.get('/', (req, res) => {
    res.status(200).send('Orchestrator SyntraNet in esecuzione.');
  });

  if (!context.state || !context.state.clientSessions) {
    console.error("[Server] ERRORE: Impossibile configurare route API /api/sessions. state o clientSessions non disponibili.");
  } else {
    app.get('/api/sessions', (req, res) => {
      const userAddress = req.query.userAddress;
      const sessions = Array.from(context.state.clientSessions.values())
        .filter(s => !userAddress || s.userAddress === userAddress)
        .map(s => ({
          id: s.id,
          status: s.status,
          podName: s.podName,
          contributorId: s.contributorId
        }));
      res.json({ success: true, sessions });
    });
  }

  if (!context.state || !context.state.clientSessions) {
    console.error("[Server] ERRORE: Impossibile configurare route API /api/sessions/:clientId/terminate. state o clientSessions non disponibili.");
  } else {
    app.post('/api/sessions/:clientId/terminate', (req, res) => {
      const clientId = req.params.clientId;
      if (!context.state.clientSessions.has(clientId)) {
        return res.status(404).json({ success: false, error: 'Sessione non trovata' });
      }
      performCleanup(clientId, 'Terminata via API dashboard');
      return res.json({ success: true });
    });
  }

  if (!context.state) {
    console.error("[Server] ERRORE: Impossibile configurare route API /health. state non disponibile.");
  } else {
    app.get('/health', (req, res) => {
      const healthStatus = {
        status: "OK",
        timestamp: new Date().toISOString(),
        websocket_clients: {
          contributors: context.state.contributorNodes ? context.state.contributorNodes.size : 0,
          clients: context.state.clientSessions ? context.state.clientSessions.size : 0,
          dashboards: context.state.dashboardSockets ? context.state.dashboardSockets.size : 0,
        }
        // Potresti aggiungere uno stato opzionale per IPFS qui se lo inizializzi in modo non fatale
        // ipfs_status: context.ipfsAvailable ? 'available' : 'unavailable'
      };
      res.status(200).json(healthStatus);
    });
  }

  if (!context.k8sPodLifecycle || typeof context.k8sPodLifecycle.setDefaultImage !== 'function') {
    console.warn("[Server] Avviso: k8sPodLifecycle o la sua funzione setDefaultImage non disponibili nel contesto. La route /api/set-pod-image NON sarà funzionante.");
  } else {
    app.post('/api/set-pod-image', (req, res) => {
      const { imageName } = req.body;

      if (!imageName || typeof imageName !== 'string' || !imageName.trim()) {
        console.warn('[Server] Richiesta /api/set-pod-image ricevuta senza un imageName valido.');
        return res.status(400).json({ success: false, error: 'Il campo imageName è obbligatorio e deve essere una stringa non vuota.' });
      }

      try {
        context.k8sPodLifecycle.setDefaultImage(imageName);
        res.json({ success: true, message: `Immagine Pod predefinita impostata su: ${imageName}` });
      } catch (error) {
        console.error(`[Server] Errore durante l'impostazione dell'immagine Pod predefinita tramite k8sPodLifecycle: ${error.message}`);
        console.error(error);
        res.status(500).json({ success: false, error: 'Errore interno del server durante l\'impostazione dell\'immagine.' });
      }
    });
  }

  app.use(express.static(path.join(__dirname, 'frontend')));

  server = http.createServer(app);
  context.server = server;

  if (context.websocketHandler && typeof context.websocketHandler.initializeWebSocketServer === 'function') {
    context.websocketHandler.initializeWebSocketServer(context.server, context);
  } else {
    console.error("[Server] ERRORE FATALE: websocketHandler o la sua funzione di inizializzazione non disponibili nel contesto. Impossibile avviare WebSocket server.");
    process.exit(1);
  }

  startPeriodicTasks();

  if (!context.config || typeof context.config.PORT === 'undefined') {
    console.error("[Server] ERRORE FATALE: Porta del server non definita nel contesto.");
    process.exit(1);
  }
  server.listen(context.config.PORT, () => {
    console.log(`[Server] Orchestrator SyntraNet in ascolto sulla porta ${context.config.PORT}.`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[Server] ERRORE FATALE: La porta ${context.config.PORT} è già in uso. Impossibile avviare il server.`);
    } else {
      console.error(`[Server] ERRORE FATALE: Impossibile avviare il server HTTP: ${error.message}`);
    }
    process.exit(1);
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (error, origin) => {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error(`[Server] ECCEZIONE NON CATTURATA RILEVATA! Origine: ${origin}`);
    console.error(error);
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    if (context && context.server && !isShuttingDown) {
      shutdown('uncaughtException');
    } else {
      console.error("[Server] Uscita immediata a causa di eccezione non catturata (spegnimento già in corso o server non disponibile).");
      process.exit(1);
    }
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("[Server] RIGETTO PROMISE NON GESTITO RILEVATO!");
    console.error("Motivo:", reason);
    // console.error("Promessa:", promise); // Rimosso per brevità, potrebbe essere utile per debug
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  });
}

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) {
    console.warn(`[Server] Ricevuto segnale ${signal}, ma spegnimento è già in corso.`);
    return;
  }
  isShuttingDown = true;
  console.error(`\n[Server] Ricevuto ${signal}. Avvio spegnimento controllato...`);

  stopPeriodicTasks();

  if (context.server) {
    console.error("[Server] Chiusura server HTTP...");
    context.server.close((err) => {
      if (err) {
        console.error("[Server] Errore durante la chiusura del server HTTP:", err);
      }
      console.error("[Server] Server HTTP chiuso.");

      if (context.websocketHandler && typeof context.websocketHandler.closeAllConnections === 'function') {
        console.error("[Server] Chiusura connessioni WebSocket...");
        context.websocketHandler.closeAllConnections("Spegnimento server");
        console.error("[Server] Connessioni WebSocket chiuse.");
      } else {
        console.warn("[Server] Avviso: Impossibile chiudere connessioni WebSocket (handler non disponibile). Pulizia manuale dello stato...");
        if (context.state) {
          const contributors = Array.from(context.state.contributorNodes?.values() || []);
          contributors.forEach((node) => node.ws?.close(1001, "Spegnimento server"));
          if (context.state.contributorNodes) context.state.contributorNodes.clear();

          const dashboards = Array.from(context.state.dashboardSockets?.values() || []);
          dashboards.forEach((dashInfo) => dashInfo.ws?.close(1001, "Spegnimento server"));
          if (context.state.dashboardSockets) context.state.dashboardSockets.clear();

          console.error("[Server] Stato WebSocket pulito manualmente.");
        }
      }

      if (context.state && context.state.clientSessions) {
        console.error("[Server] Esecuzione cleanup per sessioni client attive...");
        const clientIds = Array.from(context.state.clientSessions.keys());
        clientIds.forEach((id) => {
          performCleanup(id, "Spegnimento Server");
        });
        context.state.clientSessions.clear();
        console.error("[Server] Tutte le sessioni client sono state sottoposte a cleanup.");
      } else {
        console.warn("[Server] Avviso: Impossibile eseguire cleanup sessioni client (stato non disponibile).");
      }

      console.error("[Server] Pulizia completata.");

      setTimeout(() => {
        console.error("[Server] Spegnimento controllato completato. Uscita.");
        process.exit(0);
      }, 1000);

    });

    setTimeout(() => {
      console.error("[Server] Timeout spegnimento controllato (15s). Uscita forzata.");
      process.exit(1);
    }, 15000);

  } else {
    console.error("[Server] Server HTTP non inizializzato o non trovato nel contesto. Uscita immediata.");
    process.exit(1);
  }
}

initializeApp();
