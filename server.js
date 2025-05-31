// server.js

require("dotenv").config(); // Per sviluppo locale fuori Docker

const http = require("http");
const { exec } = require("child_process");
const express = require("express");
const cors = require("cors");
const path = require("path");

// --- INIZIO SEZIONE DA ADATTARE ALLA TUA STRUTTURA DI REPOSITORY ---
// Modifica questi percorsi 'require' per farli corrispondere a dove si trovano
// i tuoi moduli nel repository SyntraSwarm, relativi a questo file server.js.
// Esempio: se config.js è nella stessa directory di server.js, usa './config'.
const config = require("./SyntraCloud/config");
const state = require("./SyntraCloud/state");
const utils = require("./SyntraCloud/utils");
const dashboardService = require("./SyntraCloud/services/dashboardService");
const keepAlive = require("./SyntraCloud/infra/keepAlive");
const sessionManager = require("./SyntraCloud/session/manager");
const websocketHandler = require("./SyntraCloud/network/websocketHandler");
const k8sPodLifecycle = require("./SyntraCloud/infra/kubernetes/podLifecycle"); // Usato per /api/set-pod-image
const ipfsService = require("./SyntraCloud/services/ipfsService"); // Usato in runInitialChecks
// --- FINE SEZIONE DA ADATTARE ---

const app = express();
let server; // Istanza del server HTTP
let backupIntervalId = null;
let dashboardIntervalId = null;
let isShuttingDown = false;

const KUBECONFIG_PATH_IN_CONTAINER = "/root/.kube/config-for-docker";
const KUBECTL_TIMEOUT = 60000; // Timeout aumentato a 60 secondi per i comandi kubectl

// Middleware
app.use(cors());
app.use(express.json());

// Serve file statici dalla directory 'frontend' (adatta il percorso se necessario)
// Assumendo che 'frontend' sia una sottodirectory nella stessa posizione di server.js
// Se server.js è in /opt/app e frontend è in /opt/app/frontend, questo è corretto.
app.use(express.static(path.join(__dirname, 'frontend')));

async function runInitialChecks() {
    console.log("[Server] Avvio controlli iniziali...");
    let checksPassed = true;

    if (!config || !config.K8S_NAMESPACE) {
        const errMsg = "Configurazione (config.js o config.K8S_NAMESPACE) non trovata o incompleta.";
        console.error(`[Server] ERRORE FATALE: ${errMsg}`);
        // In un'applicazione reale, potresti voler lanciare un errore qui
        // per fermare l'avvio se la configurazione è critica.
        throw new Error(errMsg);
    }
    const NAMESPACE_TO_CHECK = config.K8S_NAMESPACE;

    // 1. Controllo client kubectl
    try {
        await new Promise((resolve, reject) => {
            const commandClient = `kubectl --kubeconfig=${KUBECONFIG_PATH_IN_CONTAINER} version --client --output=json`;
            console.log(`[Server][DEBUG_EXEC] CHECK CLIENT: ${commandClient}`);
            exec(commandClient, { timeout: KUBECTL_TIMEOUT, env: { ...process.env, KUBECONFIG: KUBECONFIG_PATH_IN_CONTAINER } }, (err, stdout, stderr) => {
                console.log(`[Server][DEBUG_EXEC] CHECK CLIENT - STDOUT: ${stdout}`);
                console.log(`[Server][DEBUG_EXEC] CHECK CLIENT - STDERR: ${stderr}`);
                if (err) {
                    console.error(`[Server][DEBUG_EXEC] CHECK CLIENT - Errore (err object):`, err);
                    return reject(new Error(`Controllo client kubectl fallito: ${stderr || err.message || `Code: ${err.code}, Signal: ${err.signal}`}`));
                }
                try {
                    const versionInfo = JSON.parse(stdout);
                    console.log(`[Server] Controllo client kubectl OK. Versione client: ${versionInfo.clientVersion?.gitVersion || 'N/A'}`);
                    resolve();
                } catch (parseErr) {
                    reject(new Error(`Errore parsing output versione kubectl: ${parseErr.message}`));
                }
            });
        });
    } catch (k8sClientErr) {
        console.error(`[Server] ERRORE CONTROLLO KUBECTL CLIENT: ${k8sClientErr.message}`);
        checksPassed = false;
    }

    // 2. Controllo namespace
    if (checksPassed) {
        try {
            await new Promise((resolve, reject) => {
                const commandNs = `kubectl --kubeconfig=${KUBECONFIG_PATH_IN_CONTAINER} get namespace ${NAMESPACE_TO_CHECK} -o name`;
                console.log(`[Server][DEBUG_EXEC] CHECK NAMESPACE: ${commandNs}`);
                exec(commandNs, { timeout: KUBECTL_TIMEOUT, env: { ...process.env, KUBECONFIG: KUBECONFIG_PATH_IN_CONTAINER } }, (err, stdout, stderr) => {
                    console.log(`[Server][DEBUG_EXEC] CHECK NAMESPACE - STDOUT: ${stdout}`);
                    console.log(`[Server][DEBUG_EXEC] CHECK NAMESPACE - STDERR: ${stderr}`);
                    if (err) {
                        console.error(`[Server][DEBUG_EXEC] CHECK NAMESPACE - Errore (err object):`, err);
                        const detailedErrorMsg = stderr || err.message || `Errore sconosciuto (codice: ${err.code}, segnale: ${err.signal})`;
                        return reject(new Error(`Namespace Kubernetes '${NAMESPACE_TO_CHECK}' non trovato o inaccessibile: ${detailedErrorMsg}`));
                    }
                    if (!stdout || !stdout.trim().includes(`namespace/${NAMESPACE_TO_CHECK}`)) {
                        return reject(new Error(`Namespace Kubernetes '${NAMESPACE_TO_CHECK}' non trovato nell'output (output: ${stdout.trim()}).`));
                    }
                    console.log(`[Server] Controllo namespace '${NAMESPACE_TO_CHECK}' OK: ${stdout.trim()}`);
                    resolve();
                });
            });
        } catch (k8sNsErr) {
            console.error(`[Server] ERRORE CONTROLLO NAMESPACE: ${k8sNsErr.message}`);
            checksPassed = false;
        }
    }

    // 3. Controllo directory di backup
    if (checksPassed && utils && typeof utils.ensureBackupDirExists === 'function') {
        try {
            await utils.ensureBackupDirExists();
            console.log("[Server] Controllo directory di backup OK.");
        } catch (dirErr) {
            console.error(`[Server] ERRORE DIRECTORY BACKUP: Impossibile assicurare l'esistenza della directory di backup temporanea: ${dirErr.message}`);
            checksPassed = false;
        }
    } else if (!utils || typeof utils.ensureBackupDirExists !== 'function') {
        console.warn("[Server] Avviso: Funzione ensureBackupDirExists non trovata in utils. Controllo directory di backup saltato.");
    }
    
    // 4. Inizializzazione IPFS
    if (checksPassed && ipfsService && typeof ipfsService.initializeIpfsClient === 'function') {
        try {
            await ipfsService.initializeIpfsClient();
            console.log("[Server] Inizializzazione client IPFS OK.");
        } catch (ipfsErr) {
            console.error(`[Server] ERRORE INIZIALIZZAZIONE IPFS: ${ipfsErr.message}. L'applicazione potrebbe funzionare con funzionalità IPFS limitate o assenti.`);
            // Decidi se questo errore è fatale per l'avvio.
            // checksPassed = false; // Decommenta se IPFS è critico
        }
    } else {
        console.warn("[Server] Avviso: ipfsService o initializeIpfsClient non trovati. Inizializzazione IPFS saltata.");
    }

    if (!checksPassed) {
        const failMsg = "Uno o più controlli iniziali sono falliti. Uscita dall'applicazione.";
        console.error(`[Server] ${failMsg}`);
        throw new Error(failMsg); // Lancia un errore per essere gestito da startServer()
    }

    console.log("[Server] Tutti i controlli iniziali sono stati superati.");
}

function startPeriodicTasks() {
    if (!config || !state || !sessionManager || !dashboardService) {
        console.error("[Server] ERRORE: Impossibile avviare task periodici. Moduli di base mancanti.");
        return;
    }
    console.log("[Server] Avvio task periodici...");

    if (config.BACKUP_INTERVAL_MS && config.BACKUP_INTERVAL_MS > 0 && sessionManager.triggerBackup) {
        backupIntervalId = setInterval(() => {
            if (!state.clientSessions) return;
            const activeClients = Array.from(state.clientSessions.values()).filter(
                (session) => session.status === "active" && !session.backupInProgress
            );
            activeClients.forEach((session) => {
                console.log(`[Server][BackupTask] Trigger backup per client ${session.id}`);
                sessionManager.triggerBackup(session.id).catch(err => {
                    console.error(`[Server][BackupTask] Errore nell'attivare il backup per ${session.id}: ${err.message}`);
                });
            });
        }, config.BACKUP_INTERVAL_MS);
        console.log(`[Server] Task di backup periodico avviato (ogni ${config.BACKUP_INTERVAL_MS / 1000 / 60} min).`);
    } else {
        console.log("[Server] Task di backup periodico non avviato.");
    }

    if (config.DASHBOARD_UPDATE_INTERVAL_MS && config.DASHBOARD_UPDATE_INTERVAL_MS > 0 && dashboardService.broadcastDashboardUpdate) {
        dashboardIntervalId = setInterval(dashboardService.broadcastDashboardUpdate, config.DASHBOARD_UPDATE_INTERVAL_MS);
        console.log(`[Server] Task di aggiornamento dashboard avviato (ogni ${config.DASHBOARD_UPDATE_INTERVAL_MS / 1000}s).`);
    } else {
        console.log("[Server] Task di aggiornamento dashboard non avviato.");
    }

    if (keepAlive && typeof keepAlive.startKeepAlive === 'function') {
        keepAlive.startKeepAlive();
        console.log("[Server] Servizio KeepAlive avviato.");
    } else {
        console.warn("[Server] Avviso: Servizio KeepAlive non avviato.");
    }
}

function stopPeriodicTasks() {
    console.log("[Server] Arresto task periodici...");
    if (backupIntervalId) clearInterval(backupIntervalId);
    if (dashboardIntervalId) clearInterval(dashboardIntervalId);
    if (keepAlive && typeof keepAlive.stopKeepAlive === 'function') {
        keepAlive.stopKeepAlive();
        console.log("[Server] Servizio KeepAlive arrestato.");
    }
    backupIntervalId = null;
    dashboardIntervalId = null;
}

// API Routes
app.get('/health', (req, res) => {
    const healthStatus = {
        status: "OK",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        active_contributors: state.contributorNodes ? state.contributorNodes.size : 0,
        active_client_sessions: state.clientSessions ? state.clientSessions.size : 0,
    };
    res.status(200).json(healthStatus);
});

if (k8sPodLifecycle && typeof k8sPodLifecycle.setDefaultImage === 'function') {
    app.post('/api/set-pod-image', (req, res) => {
        const { imageName } = req.body;
        if (!imageName || typeof imageName !== 'string' || !imageName.trim()) {
            return res.status(400).json({ success: false, error: 'Il campo imageName è obbligatorio e deve essere una stringa non vuota.' });
        }
        try {
            k8sPodLifecycle.setDefaultImage(imageName);
            console.log(`[Server] Immagine Pod predefinita aggiornata a: ${imageName} via API`);
            res.json({ success: true, message: `Immagine Pod predefinita impostata su: ${imageName}` });
        } catch (error) {
            console.error(`[Server] Errore API /api/set-pod-image: ${error.message}`);
            res.status(500).json({ success: false, error: 'Errore interno del server durante l\'impostazione dell\'immagine.' });
        }
    });
} else {
    console.warn("[Server] k8sPodLifecycle.setDefaultImage non disponibile. Route /api/set-pod-image non attiva.");
}


async function startServer() {
    try {
        await runInitialChecks(); // Attende il completamento dei check prima di procedere
        
        server = http.createServer(app);

        if (websocketHandler && typeof websocketHandler.initializeWebSocketServer === 'function') {
            websocketHandler.initializeWebSocketServer(server); // Passa l'istanza del server HTTP
        } else {
            console.error("[Server] ERRORE FATALE: websocketHandler o la sua funzione di inizializzazione non disponibili.");
            throw new Error("websocketHandler non correttamente inizializzato.");
        }

        startPeriodicTasks();

        const PORT = config.PORT || 5501;
        server.listen(PORT, () => {
            console.log(`[Server] Orchestrator SyntraNet in ascolto sulla porta ${PORT}. Ambiente: ${process.env.NODE_ENV || 'development'}`);
        });

        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`[Server] ERRORE FATALE: La porta ${PORT} è già in uso.`);
            } else {
                console.error(`[Server] ERRORE FATALE SERVER HTTP: ${error.message}`);
            }
            shutdown('server_error_listen', true);
        });

    } catch (error) {
        console.error(`[Server] ERRORE FATALE durante l'inizializzazione: ${error.message}`);
        // L'errore da runInitialChecks è già stato loggato.
        // Non è necessario loggare error.stack qui se non si vuole duplicare.
        process.exit(1); // Esce con codice di errore
    }
}

function shutdown(signal, forceExit = false) {
    if (isShuttingDown && !forceExit) {
        console.warn(`[Server] Ricevuto segnale ${signal}, ma spegnimento è già in corso.`);
        return;
    }
    isShuttingDown = true;
    console.warn(`\n[Server] Ricevuto ${signal}. Avvio spegnimento controllato...`);

    stopPeriodicTasks();

    if (state && state.clientSessions && sessionManager && typeof sessionManager.cleanupClientSession === 'function') {
        console.log("[Server] Chiusura sessioni client attive...");
        Array.from(state.clientSessions.keys()).forEach(clientId => {
            try {
                sessionManager.cleanupClientSession(clientId, `Spegnimento server (${signal})`);
            } catch (cleanupErr) {
                console.error(`[Server] Errore durante cleanup sessione ${clientId}: ${cleanupErr.message}`);
            }
        });
    } else {
        console.warn("[Server] Impossibile eseguire cleanup sessioni client: moduli o stato mancanti.");
    }
    
    if (websocketHandler && typeof websocketHandler.closeAllOtherConnections === 'function') {
        console.log("[Server] Chiusura altre connessioni WebSocket...");
        try {
            websocketHandler.closeAllOtherConnections(`Spegnimento server (${signal})`);
        } catch (wsErr) {
            console.error(`[Server] Errore chiusura altre connessioni WS: ${wsErr.message}`);
        }
    } else if (state) { 
        console.warn("[Server] Fallback: chiusura manuale connessioni contributor/dashboard.");
        if (state.contributorNodes) {
            Array.from(state.contributorNodes.values()).forEach(node => { try { node.ws?.close(1001, "Spegnimento server"); } catch(e){} });
        }
        if (state.dashboardSockets) {
            Array.from(state.dashboardSockets.values()).forEach(dash => { try { dash.ws?.close(1001, "Spegnimento server"); } catch(e){} });
        }
    }

    if (server) {
        console.log("[Server] Chiusura server HTTP...");
        server.close((err) => {
            if (err) {
                console.error("[Server] Errore durante la chiusura del server HTTP:", err);
                process.exit(1);
            } else {
                console.log("[Server] Server HTTP chiuso. Spegnimento completato.");
                process.exit(0);
            }
        });

        setTimeout(() => {
            console.error("[Server] Timeout spegnimento controllato (10s). Uscita forzata.");
            process.exit(1);
        }, 10000).unref();
    } else {
        console.log("[Server] Server HTTP non avviato o già chiuso. Uscita.");
        process.exit(0);
    }
}

// Gestione Segnali di Uscita
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Gestione Errori Non Catturati
process.on("uncaughtException", (error, origin) => {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error(`[Server] ECCEZIONE NON CATTURATA! Origine: ${origin}`);
    console.error("Errore:", error);
    console.error("Stack:", error.stack);
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    if (!isShuttingDown) {
        shutdown('uncaughtException', true);
    } else {
        // Se già in spegnimento, potrebbe essere un errore durante lo spegnimento stesso.
        // Uscita forzata per evitare loop.
        console.error("[Server] Eccezione non catturata durante lo spegnimento. Uscita forzata.");
        process.exit(1);
    }
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("[Server] RIGETTO PROMISE NON GESTITO!");
    console.error("Motivo del rigetto:", reason);
    // console.error("Promise:", promise); // Può essere molto verboso
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    // In produzione, un unhandledRejection dovrebbe probabilmente far terminare il processo
    // dopo aver tentato un cleanup, perché lo stato dell'applicazione potrebbe essere inconsistente.
    // if (!isShuttingDown) {
    //     shutdown('unhandledRejection');
    // }
});

// Avvio effettivo del server
startServer();