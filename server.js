// server.js

// Carica prima le variabili d'ambiente da .env se presenti (utile per sviluppo locale fuori Docker)
// In Docker, queste verranno passate da docker-compose
require("dotenv").config();

const http = require("http");
const { exec } = require("child_process");
const express = require("express");
const cors = require("cors");
const path = require("path");

// Assumiamo che la tua configurazione e la logica principale siano in SyntraCloud
// Adatta i percorsi se necessario, basandoti sulla struttura del repo SyntraSwarm
// Se i file sono direttamente nella root con server.js, i percorsi cambiano (es. './config')
const config = require("./SyntraCloud/config"); // Potrebbe essere solo './config' se config è nella root
const state = require("./SyntraCloud/state");   // Potrebbe essere solo './state'
const utils = require("./SyntraCloud/utils");   // Potrebbe essere solo './utils'
const dashboardService = require("./SyntraCloud/services/dashboardService");
const keepAlive = require("./SyntraCloud/infra/keepAlive");
const sessionManager = require("./SyntraCloud/session/manager");
const websocketHandler = require("./SyntraCloud/network/websocketHandler");
const k8sPodLifecycle = require("./SyntraCloud/infra/kubernetes/podLifecycle"); // Se usato direttamente
const ipfsService = require("./SyntraCloud/services/ipfsService"); // Se usato

const app = express();
let server;
let backupIntervalId = null;
let dashboardIntervalId = null;
let isShuttingDown = false;

// Il percorso del kubeconfig all'interno del container, come definito in docker-compose.yml
const KUBECONFIG_PATH_IN_CONTAINER = "/root/.kube/config-for-docker";

// ---- MIDDLEWARE ----
app.use(cors());
app.use(express.json());

// Serve i file statici della frontend se presente
// Adatta il percorso a 'frontend' se è diverso nel repo clonato
app.use(express.static(path.join(__dirname, 'frontend')));


// ---- FUNZIONE DI CHECK INIZIALE CON KUBECTL CORRETTO ----
async function runInitialChecks() {
    console.log("[Server] Avvio controlli iniziali...");
    let checksPassed = true;

    if (!config || !config.K8S_NAMESPACE) {
        console.error("[Server] ERRORE FATALE: Configurazione (config.js o config.K8S_NAMESPACE) non trovata o incompleta.");
        return Promise.reject(new Error("Configurazione mancante o K8S_NAMESPACE non definito."));
    }

    // 1. Controllo client kubectl
    // Dentro runInitialChecks, per il controllo del namespace:
try {
    await new Promise((resolve, reject) => {
        const KUBECONFIG_PATH = "/root/.kube/config-for-docker"; // Definito prima
        const NAMESPACE_TO_CHECK = config.K8S_NAMESPACE; // Assumendo che config.K8S_NAMESPACE sia 'syntracloud'

        const command = `kubectl --kubeconfig=${KUBECONFIG_PATH} get namespace ${NAMESPACE_TO_CHECK} -o name`;
        
        console.log(`[Server][DEBUG_EXEC] Tentativo esecuzione comando: ${command}`);
        console.log(`[Server][DEBUG_EXEC] Variabili d'ambiente del processo Node.js (parziale): KUBECONFIG=${process.env.KUBECONFIG}, PATH=${process.env.PATH}`);

        exec(command, { timeout: 15000, env: { ...process.env, KUBECONFIG: KUBECONFIG_PATH_IN_CONTAINER } }, (err, stdout, stderr) => { // Aggiunto env esplicito
            console.log(`[Server][DEBUG_EXEC] Comando eseguito.`);
            console.log(`[Server][DEBUG_EXEC] Errore (err object):`, err);
            console.log(`[Server][DEBUG_EXEC] STDOUT:\n${stdout}`);
            console.log(`[Server][DEBUG_EXEC] STDERR:\n${stderr}`);

            if (err) {
                const detailedError = `Codice: ${err.code}, Segnale: ${err.signal}, STDERR: ${stderr || 'N/A'}, STDOUT: ${stdout || 'N/A'}`;
                console.error(`[Server] Errore controllo namespace '${NAMESPACE_TO_CHECK}' con exec: ${detailedError}`);
                return reject(new Error(`Namespace Kubernetes '${NAMESPACE_TO_CHECK}' non trovato o inaccessibile: ${stderr || err.message || detailedError}`));
            }
            if (!stdout || !stdout.trim().includes(`namespace/${NAMESPACE_TO_CHECK}`)) {
                console.error(`[Server] Output controllo namespace '${NAMESPACE_TO_CHECK}' non valido: ${stdout}`);
                return reject(new Error(`Namespace Kubernetes '${NAMESPACE_TO_CHECK}' non trovato nell'output (output: ${stdout.trim()}).`));
            }
            console.log(`[Server] Controllo namespace '${NAMESPACE_TO_CHECK}' OK: ${stdout.trim()}`);
            resolve();
        });
    });
} catch (k8sNsErr) {
    console.error(`[Server] ERRORE CONTROLLO NAMESPACE (blocco catch): ${k8sNsErr.message}`);
    checksPassed = false; // Assicurati che checksPassed sia definito nel contesto di questa funzione
}
    // 3. Controllo directory di backup (se la tua app la usa direttamente)
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
    
    // 4. Inizializzazione IPFS (se necessario all'avvio)
    if (checksPassed && ipfsService && typeof ipfsService.initializeIpfsClient === 'function') {
        try {
            await ipfsService.initializeIpfsClient();
            console.log("[Server] Inizializzazione client IPFS OK.");
        } catch (ipfsErr) {
            console.error(`[Server] ERRORE INIZIALIZZAZIONE IPFS: ${ipfsErr.message}. L'applicazione potrebbe funzionare con funzionalità IPFS limitate o assenti.`);
            // Decidi se questo errore debba essere fatale o solo un avviso.
            // checksPassed = false; // Decommenta se IPFS è critico per l'avvio
        }
    } else {
        console.warn("[Server] Avviso: ipfsService o initializeIpfsClient non trovati. Inizializzazione IPFS saltata.");
    }


    if (!checksPassed) {
        console.error("[Server] Uno o più controlli iniziali sono falliti. Uscita dall'applicazione.");
        // process.exit(1); // Esce immediatamente
        return Promise.reject(new Error("Controlli iniziali falliti.")); // Permette al chiamante di gestire lo shutdown
    }

    console.log("[Server] Tutti i controlli iniziali sono stati superati.");
    return Promise.resolve();
}


// ---- TASK PERIODICI ----
function startPeriodicTasks() {
    if (!config || !state || !sessionManager || !dashboardService) {
        console.error("[Server] ERRORE: Impossibile avviare task periodici. Moduli di base mancanti.");
        return;
    }

    console.log("[Server] Avvio task periodici...");

    if (backupIntervalId) clearInterval(backupIntervalId);
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
        console.log("[Server] Task di backup periodico non avviato (intervallo non configurato o funzione mancante).");
    }


    if (dashboardIntervalId) clearInterval(dashboardIntervalId);
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
        console.warn("[Server] Avviso: Servizio KeepAlive non avviato (mancante o non funzione).");
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


// ---- ROUTES API (ESEMPIO) ----
app.get('/health', (req, res) => {
    const healthStatus = {
        status: "OK",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        kubernetes_checks: "Verificare log all'avvio", // Potresti voler esporre lo stato dei check qui
        active_contributors: state.contributorNodes ? state.contributorNodes.size : 0,
        active_client_sessions: state.clientSessions ? state.clientSessions.size : 0,
    };
    res.status(200).json(healthStatus);
});

// Esempio di API per impostare l'immagine pod (adatta se k8sPodLifecycle è usato)
if (k8sPodLifecycle && typeof k8sPodLifecycle.setDefaultImage === 'function') {
    app.post('/api/set-pod-image', (req, res) => {
        const { imageName } = req.body;
        if (!imageName || typeof imageName !== 'string' || !imageName.trim()) {
            return res.status(400).json({ success: false, error: 'Il campo imageName è obbligatorio.' });
        }
        try {
            k8sPodLifecycle.setDefaultImage(imageName);
            console.log(`[Server] Immagine Pod predefinita aggiornata a: ${imageName} via API`);
            res.json({ success: true, message: `Immagine Pod predefinita impostata su: ${imageName}` });
        } catch (error) {
            console.error(`[Server] Errore API /api/set-pod-image: ${error.message}`);
            res.status(500).json({ success: false, error: 'Errore interno del server.' });
        }
    });
}


// ---- GESTIONE AVVIO E SPEGNIMENTO ----
async function startServer() {
    try {
        await runInitialChecks(); // Attende il completamento dei check
        
        server = http.createServer(app);

        if (websocketHandler && typeof websocketHandler.initializeWebSocketServer === 'function') {
            websocketHandler.initializeWebSocketServer(server);
        } else {
            console.error("[Server] ERRORE FATALE: websocketHandler o la sua funzione di inizializzazione non disponibili.");
            throw new Error("websocketHandler non inizializzato.");
        }

        startPeriodicTasks();

        server.listen(config.PORT || 5501, () => {
            console.log(`[Server] Orchestrator SyntraNet in ascolto sulla porta ${config.PORT || 5501}. Ambiente: ${process.env.NODE_ENV}`);
        });

        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`[Server] ERRORE FATALE: La porta ${config.PORT || 5501} è già in uso.`);
            } else {
                console.error(`[Server] ERRORE FATALE SERVER HTTP: ${error.message}`);
            }
            shutdown('server_error_listen', true); // Forza lo shutdown
        });

    } catch (error) {
        console.error(`[Server] ERRORE FATALE durante l'inizializzazione: ${error.message}`);
        console.error(error.stack);
        // Non chiamare shutdown() qui se process.exit(1) è già in runInitialChecks
        // ma se runInitialChecks rigetta una Promise, allora è corretto uscire qui.
        process.exit(1);
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

    // Chiudi connessioni WebSocket client
    if (state && state.clientSessions) {
        console.log("[Server] Chiusura sessioni client attive...");
        Array.from(state.clientSessions.keys()).forEach(clientId => {
            sessionManager.cleanupClientSession(clientId, `Spegnimento server (${signal})`);
        });
    }
    
    // Chiudi connessioni WebSocket contributors e dashboards
    if (websocketHandler && typeof websocketHandler.closeAllOtherConnections === 'function') {
        websocketHandler.closeAllOtherConnections(`Spegnimento server (${signal})`);
    } else if (state) { // Fallback manuale
        if (state.contributorNodes) {
            Array.from(state.contributorNodes.values()).forEach(node => node.ws?.close(1001, "Spegnimento server"));
        }
        if (state.dashboardSockets) {
            Array.from(state.dashboardSockets.values()).forEach(dash => dash.ws?.close(1001, "Spegnimento server"));
        }
    }


    if (server) {
        console.log("[Server] Chiusura server HTTP...");
        server.close((err) => {
            if (err) console.error("[Server] Errore durante la chiusura del server HTTP:", err);
            else console.log("[Server] Server HTTP chiuso.");
            
            console.log("[Server] Spegnimento controllato completato. Uscita.");
            process.exit(err ? 1 : 0);
        });

        // Timeout per forzare lo spegnimento se il server non si chiude
        setTimeout(() => {
            console.error("[Server] Timeout spegnimento controllato (10s). Uscita forzata.");
            process.exit(1);
        }, 10000).unref(); // .unref() permette al processo di uscire se tutto il resto è finito prima del timeout

    } else {
        console.log("[Server] Server HTTP non avviato. Uscita.");
        process.exit(0);
    }
}

// Gestione Segnali
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error, origin) => {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error(`[Server] ECCEZIONE NON CATTURATA! Origine: ${origin}`);
    console.error(error);
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    // Prova a fare uno shutdown controllato, ma preparati a un'uscita forzata
    if (!isShuttingDown) {
        shutdown('uncaughtException', true); // Il true forza lo shutdown anche se già in corso e poi esce
    } else {
         process.exit(1); // Se già in shutdown, esci brutalmente
    }
});
process.on("unhandledRejection", (reason, promise) => {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("[Server] RIGETTO PROMISE NON GESTITO!");
    console.error("Motivo:", reason);
    // In un'app di produzione, potresti voler terminare il processo qui
    // o avere una strategia di recovery più robusta.
    // Per ora, logghiamo e continuiamo, ma è un rischio.
    // Se l'unhandledRejection è critico, considera:
    // if (!isShuttingDown) { shutdown('unhandledRejection'); }
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
});


// ---- AVVIO APPLICAZIONE ----
startServer();