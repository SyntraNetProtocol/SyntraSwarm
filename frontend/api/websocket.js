// websocket.js

(function () { // Usa un IIFE per non inquinare lo scope globale inutilmente
    'use strict';

    // Definizioni Costanti WebSocket (potrebbero venire da config)
    const WS_URL = 'ws://localhost:5501'; // Assicurati sia corretto
    const MAX_RECONNECT_ATTEMPTS = 5;
    const INITIAL_RECONNECT_DELAY = 3000; // Inizia con 3 secondi
    const MAX_RECONNECT_DELAY = 300000000; // Massimo 30 secondi

    // Stato WebSocket e Riconnessione
    let ws = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let explicitDisconnect = false; // Flag per sapere se la disconnessione è voluta
    // Salva i dettagli per la riconnessione
    let reconnectDetails = {
        userAddress: null,
        subscriptionId: null,
        username: null,
        password: null,
    };

    // Riferimenti a funzioni/oggetti esterni necessari (con nomi più chiari)
    let extTermInstance = null;
    let extLogFunction = console.log; // Default a console.log
    let extErrorFunction = console.error; // Default a console.error
    let extDisposeListeners = () => {}; // Funzione vuota di default
    let extReattachListeners = null; // DEVE essere fornita
    let extWsStatusUpdateFn = () => {}; // Per aggiornare indicatore stato UI
    let extBlockShellButtonFn = () => {}; // Per bloccare bottone durante connessione
    let extUnblockShellButtonFn = () => {}; // Per sbloccare bottone

    // Log interno al modulo
    const logWs = (message, color = '', level = 'log') => {
        const timestamp = new Date().toLocaleTimeString();
        const style = color ? `color:${color}` : '';
        // Usa la funzione di log esterna se fornita, altrimenti console
        const logFn = extLogFunction || console[level] || console.log;
        logFn(`%c[${timestamp}][WS] ${message}`, style); // Passa stile come argomento separato per console.log
    };

    function setExternalDependencies(term, logFn, errFn, disposeFn, reattachFn, updateStatusFn, blockBtnFn, unblockBtnFn) {
        extTermInstance = term;
        extLogFunction = logFn || console.log;
        extErrorFunction = errFn || console.error;
        extDisposeListeners = disposeFn || (() => {});
        extReattachListeners = reattachFn; // Salva la funzione per riattaccare
        extWsStatusUpdateFn = updateStatusFn || (() => {});
        extBlockShellButtonFn = blockBtnFn || (() => {});
        extUnblockShellButtonFn = unblockBtnFn || (() => {});
        logWs("Dipendenze esterne UI impostate.", 'gray');

        // Verifica dipendenza critica
        if (typeof extReattachListeners !== 'function') {
            logWs("ATTENZIONE: Funzione extReattachListeners non fornita! L'input del terminale non funzionerà.", 'red', 'error');
        }
         if (typeof extWsStatusUpdateFn !== 'function') {
            logWs("ATTENZIONE: Funzione extWsStatusUpdateFn non fornita! Lo stato UI non verrà aggiornato.", 'orange', 'warn');
        }
    }

    function resetReconnectState() {
        logWs("Reset stato riconnessione.", 'gray');
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectAttempts = 0;
        // Non resettare explicitDisconnect qui, viene gestito da connect/disconnect
        // Non resettare reconnectDetails qui, potrebbero servire subito dopo
    }

    function scheduleReconnect() {
        // Non provare a riconnettere se la disconnessione era voluta
        if (explicitDisconnect) {
            logWs("Riconnessione annullata: disconnessione esplicita richiesta.", 'orange');
            resetReconnectState();
            return;
        }

        // Verifica se mancano i dettagli per riconnettere
        if (!reconnectDetails.userAddress || !reconnectDetails.subscriptionId || !reconnectDetails.username || !reconnectDetails.password) {
            logWs("Riconnessione annullata: dettagli mancanti (utente, sub, credenziali).", 'red', 'error');
            extErrorFunction("Errore Riconnessione", "Dettagli sessione mancanti per riconnessione automatica.");
            resetReconnectState();
            // Sblocca il bottone se il tentativo fallisce qui
            extUnblockShellButtonFn(false); // Passa 'false' per indicare fallimento iniziale/riconnessione
            extWsStatusUpdateFn('disconnected');
            return;
        }

        reconnectAttempts++;
        logWs(`Tentativo di riconnessione #${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}.`, 'orange');

        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            logWs(`Numero massimo di tentativi (${MAX_RECONNECT_ATTEMPTS}) raggiunto. Stop riconnessione.`, 'red');
            if (extTermInstance) extTermInstance.write(`\r\n\x1b[1;31m[Shell] Riconnessione fallita dopo ${MAX_RECONNECT_ATTEMPTS} tentativi.\x1b[0m`);
            extErrorFunction(`Riconnessione Fallita`, `Impossibile ristabilire la connessione dopo ${MAX_RECONNECT_ATTEMPTS} tentativi.`);
            resetReconnectState();
            // Sblocca bottone indicando fallimento finale
            extUnblockShellButtonFn(false);
            extWsStatusUpdateFn('failed'); // Stato specifico per fallimento
            return;
        }

        // Calcola delay con backoff esponenziale
        const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
        logWs(`Prossimo tentativo tra ${delay / 1000}s...`, 'orange');
        extWsStatusUpdateFn('reconnecting'); // Aggiorna stato UI

        if (extTermInstance) extTermInstance.write(`\r\n\x1b[1;33m[Shell] Connessione persa. Riconnessione #${reconnectAttempts} in ${delay / 1000}s...\x1b[0m`);

        clearTimeout(reconnectTimer); // Assicura che non ci siano timer duplicati
        reconnectTimer = setTimeout(() => {
            logWs(`Esecuzione tentativo riconnessione #${reconnectAttempts}...`, 'cyan');
            // Chiama connectWebSocket usando i dettagli salvati
            connectWebSocket(
                reconnectDetails.userAddress,
                reconnectDetails.subscriptionId,
                reconnectDetails.username,
                reconnectDetails.password,
                true // Passa un flag per indicare che è una riconnessione
            );
        }, delay);
    }


    function connectWebSocket(userEthAddress, subscriptionId, username, password, isRetry = false) {
        // Validazione input iniziale
        if (!username || !password || !userEthAddress || !subscriptionId) {
            const missing = [!username && 'Username', !password && 'Password', !userEthAddress && 'User Address', !subscriptionId && 'Subscription ID'].filter(Boolean).join(', ');
            logWs(`Connessione fallita: parametri mancanti (${missing}).`, "red", 'error');
            if (extTermInstance) extTermInstance.write(`\r\n\x1b[31m[Shell] Errore Connessione: Dati richiesti mancanti (${missing}).\x1b[0m`);
            extErrorFunction("Errore Connessione", `Dati richiesti mancanti: ${missing}`);
            if (isRetry) { // Se era un tentativo di riconnessione, interrompi la sequenza
                 resetReconnectState();
                 extWsStatusUpdateFn('failed');
            }
             extUnblockShellButtonFn(false); // Sblocca bottone indicando fallimento
            return;
        }

        // Salva i dettagli per future riconnessioni (anche sulla prima connessione)
        reconnectDetails = { userAddress: userEthAddress, subscriptionId, username, password };
        explicitDisconnect = false; // Una nuova connessione richiesta NON è una disconnessione esplicita

        if (!isRetry) {
            logWs(`Tentativo connessione WebSocket a ${WS_URL}...`, "cyan");
            if (extTermInstance) extTermInstance.write(`\x1b[33m[Shell] Connecting to ${WS_URL}...\x1b[0m`);
            resetReconnectState(); // Resetta tentativi solo sulla prima connessione esplicita
            extBlockShellButtonFn(); // Blocca bottone UI
            extWsStatusUpdateFn('connecting'); // Aggiorna stato UI
        } else {
             logWs(`(Riconnessione #${reconnectAttempts}) Tentativo connessione a ${WS_URL}...`, "cyan");
             // Non resettare i tentativi qui, non bloccare di nuovo il bottone
             extWsStatusUpdateFn('reconnecting'); // Già impostato da scheduleReconnect
        }

        // Scollega listener terminale PRIMA di creare nuovo WS
        if (extDisposeListeners) extDisposeListeners();

        // Chiudi connessione precedente in modo pulito se esiste
        if (ws) {
            logWs("Chiusura connessione WebSocket precedente...", 'gray');
            // Imposta un flag per sapere che questa chiusura è intenzionale e NON deve triggerare riconnessione
            const oldWs = ws;
            oldWs.onclose = () => { logWs("Vecchia connessione WS chiusa.", 'gray'); }; // Semplice log
            oldWs.onerror = () => { logWs("Errore durante chiusura vecchia connessione WS (ignorato).", 'gray'); };
            oldWs.close(1000, "Establishing new connection");
            ws = null;
        }

        try {
            logWs("Creazione nuovo oggetto WebSocket...", 'gray');
            ws = new WebSocket(WS_URL);
        } catch (error) {
            logWs(`Errore durante creazione WebSocket: ${error.message}`, "red", 'error');
            if (extTermInstance) extTermInstance.write(`\r\n\x1b[31m[Shell] Errore Creazione WebSocket: ${error.message}\x1b[0m`);
            extErrorFunction("Errore WebSocket", `Impossibile creare WebSocket: ${error.message}`);
            ws = null;
            extUnblockShellButtonFn(false); // Sblocca bottone indicando fallimento
            if (isRetry) {
                // Se era una riconnessione, prova a schedulare il prossimo tentativo
                scheduleReconnect();
            } else {
                 extWsStatusUpdateFn('failed');
            }
            return;
        }

        // --- Gestori Eventi WebSocket ---

        ws.onopen = () => {
            logWs("Connessione WebSocket aperta con successo.", 'lime');
            extWsStatusUpdateFn('connected'); // Aggiorna stato UI
            if (extTermInstance) extTermInstance.write("\r\n\x1b[32m[Shell] Connesso. Invio richiesta terminale...\x1b[0m");

            // Resetta stato riconnessione su successo
            resetReconnectState(); // Cancella timer e resetta tentativi

            // Payload iniziale per richiedere il terminale
            const payload = JSON.stringify({
                type: "request_terminal",
                userAddress: userEthAddress,
                username: username, // Ricorda: insicuro
                password: password, // Ricorda: insicuro
                subscriptionId: subscriptionId
            });
            logWs("Invio payload iniziale:", 'gray');
            console.log(payload);

            try {
                ws.send(payload);

                // --- RIATTACCA LISTENER TERMINALE --- (Punto chiave!)
                if (typeof extReattachListeners === 'function') {
                    logWs("Tentativo di riattaccare i listener del terminale...", 'yellow');
                    try {
                        extReattachListeners(); // CHIAMA LA CALLBACK CORRETTA!
                        logWs("Callback extReattachListeners chiamata con successo.", 'lime');
                        // Il focus viene gestito dentro attachTerminalListeners
                        extUnblockShellButtonFn(true); // Sblocca bottone indicando successo connessione
                    } catch (e) {
                        logWs(`Errore durante chiamata a extReattachListeners: ${e.message}`, 'red', 'error');
                        console.error(e);
                        extErrorFunction("Errore Interno UI", "Impossibile riattivare listener terminale.");
                        extUnblockShellButtonFn(false); // Sblocca ma indica fallimento setup listener
                        // Considera se chiudere la connessione qui?
                    }
                } else {
                    logWs("ERRORE CRITICO: Funzione extReattachListeners non definita/passata!", 'red', 'error');
                    extErrorFunction("Errore Interno Setup", "Callback ReattachListeners mancante.");
                    extUnblockShellButtonFn(false);
                    // Chiudi connessione perché l'input non funzionerà
                    disconnectWebSocket("Setup listener fallito");
                }
                // ---------------------------------

            } catch (sendError) {
                logWs(`Errore invio payload iniziale WS: ${sendError.message}`, "red", 'error');
                if (extTermInstance) extTermInstance.write(`\r\n\x1b[31m[Shell] Errore invio richiesta: ${sendError.message}\x1b[0m`);
                extErrorFunction("Errore Invio WS", `Impossibile inviare richiesta: ${sendError.message}`);
                extUnblockShellButtonFn(false);
                disconnectWebSocket("Errore invio iniziale"); // Chiudi connessione
            }
        };

        ws.onmessage = (evt) => {
            // Logica per gestire messaggi JSON o dati grezzi (come prima)
            try {
                 // Scrivi sempre sul terminale esterno, se esiste
                if (!extTermInstance) return;

                if (typeof evt.data === 'string') {
                    let parsedData;
                    try {
                        parsedData = JSON.parse(evt.data);
                        // Log più specifico per debug
                        logWs(`[RX JSON]: Type: ${parsedData.type}, Status: ${parsedData.status}, Msg: ${parsedData.message}`, 'gray');

                        // Gestione tipi di messaggio specifici
                        if (parsedData.type === 'error' || parsedData.status === 'failed' || parsedData.status?.includes('fail')) {
                            extLogFunction(`Errore Server: ${parsedData.message}`, "red"); // Usa log UI
                            extTermInstance.write(`\r\n\x1b[1;31m[SRV ERR] ${parsedData.message}\x1b[0m\r\n`);
                            // Controlla se interrompere la riconnessione per errori specifici
                            if (parsedData.message?.toLowerCase().includes("permanently") || parsedData.message?.toLowerCase().includes("verification failed") || parsedData.message?.toLowerCase().includes("duplicate session")) {
                                logWs("Disabilitazione riconnessione automatica per errore permanente/duplicato.", 'orange');
                                explicitDisconnect = true; // Impedisce futuri tentativi
                            }
                        } else if (parsedData.type === 'warning' || parsedData.status?.includes('warn')) {
                            extLogFunction(`Warning Server: ${parsedData.message}`, "orange");
                            extTermInstance.write(`\r\n\x1b[1;33m[SRV WARN] ${parsedData.message}\x1b[0m\r\n`);
                        } else if (parsedData.type === 'info' || parsedData.status === 'recovering' || parsedData.status === 'recovered') {
                             extLogFunction(`Info Server: ${parsedData.message}`, "cyan");
                            extTermInstance.write(`\r\n\x1b[1;36m[SRV INFO] ${parsedData.message}\x1b[0m\r\n`);
                        } else if (parsedData.type === 'ack_request' || parsedData.type === 'verification_success' || parsedData.type === 'terminal_ready') {
                             extLogFunction(`Stato: ${parsedData.message}`, "lime");
                            extTermInstance.write(`\r\n\x1b[32m[Status] ${parsedData.message}\x1b[0m\r\n`);
                            // Non dare focus qui, viene dato dopo attachListeners
                        } else if (parsedData.type === 'terminal_output') {
                             // Se il backend invia output specifico
                             if (parsedData.data) extTermInstance.write(parsedData.data);
                        }
                         else {
                            // Scrivi JSON non riconosciuto come testo (meno probabile)
                             logWs(`[RX JSON non gestito]: ${evt.data}`, 'gray');
                            extTermInstance.write(evt.data);
                        }
                    } catch (_) {
                        // Non era JSON, scrivi direttamente come output del terminale
                         // logWs(`[RX Raw]: ${evt.data.length} chars`, 'gray'); // Log verbose
                        extTermInstance.write(evt.data);
                    }
                } else if (evt.data instanceof Blob) {
                    // Gestione Blob (come prima)
                    const reader = new FileReader();
                    reader.onload = () => { if (reader.result && extTermInstance) extTermInstance.write(reader.result); };
                    reader.readAsText(evt.data);
                } else {
                     // Altro tipo (ArrayBuffer?)
                     logWs(`[RX Unhandled Type]: ${typeof evt.data}`, 'orange');
                     if (extTermInstance) extTermInstance.write(String(evt.data));
                }
            } catch (termError) {
                logWs(`Errore scrittura su terminale: ${termError.message}`, 'red', 'error');
                console.error("Terminal write error:", termError);
            }
        };

        ws.onerror = (errorEvent) => {
            logWs(`Errore WebSocket rilevato.`, 'red', 'error');
            // Logga l'evento errore che può contenere più info
            console.error("[WS] WebSocket Error Event:", errorEvent);
            // L'evento 'onclose' viene solitamente chiamato subito dopo 'onerror',
            // quindi la logica di riconnessione verrà gestita lì.
            // Possiamo aggiornare lo stato UI qui se necessario.
            extWsStatusUpdateFn('error');
            // Non chiamare scheduleReconnect qui, attendi onclose.
        };

        ws.onclose = (closeEvent) => {
            const reason = closeEvent.reason || 'No reason provided';
            const codeMsg = `Code=${closeEvent.code}`;
            // 1000 Normal Closure, 1001 Going Away (es. navigazione pagina), 1006 Abnormal Closure
            const wasClean = closeEvent.wasClean;
            const wasNormal = (closeEvent.code === 1000 || closeEvent.code === 1001);

            logWs(`Connessione WebSocket chiusa. ${codeMsg}, Clean: ${wasClean}, Reason: "${reason}"`, wasNormal ? 'orange' : 'red');
            if (extTermInstance) extTermInstance.write(`\r\n\x1b[1;31m[Shell] Disconnesso. ${codeMsg}, Reason=${reason}\x1b[0m`);
            extWsStatusUpdateFn('disconnected');

            ws = null; // Rimuovi riferimento
            if (extDisposeListeners) extDisposeListeners(); // Scollega listener terminale

            // --- Logica di Riconnessione (solo se NON è stata una disconnessione esplicita) ---
            if (!explicitDisconnect) {
                logWs("Tentativo di schedulare riconnessione (disconnessione non esplicita)...", 'gray');
                scheduleReconnect(); // Prova a riconnettere usando i dettagli salvati
            } else {
                logWs("Disconnessione esplicita. Nessuna riconnessione verrà tentata.", 'orange');
                resetReconnectState(); // Pulisci stato riconnessione
                 extUnblockShellButtonFn(false); // Assicura che il bottone sia sbloccato dopo disconnessione voluta
            }
            // ------------------------------------------------------------------------------------
        };
    }

    // --- Funzioni per Inviare Dati al Backend ---

    function sendTerminalData(data) {
        if (ws?.readyState === WebSocket.OPEN) {
            try {
                ws.send(data); // Invia dati grezzi (stringa o binari)
            } catch (e) {
                 logWs(`Errore invio dati terminale: ${e.message}`, 'red', 'error');
                 if(extTermInstance) extTermInstance.write(`\r\n\x1b[31m[Shell] Errore invio dati WS: ${e.message}\x1b[0m`);
            }
        } else {
            // logWs("Impossibile inviare dati: WebSocket non connesso.", 'orange', 'warn'); // Troppo verboso
        }
    }

    function sendTerminalResize(cols, rows) {
        if (ws?.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify({ type: 'resize', cols, rows });
            try {
                // logWs(`Invio resize: ${cols}x${rows}`, 'gray');
                ws.send(payload);
            } catch (e) {
                logWs(`Errore invio resize: ${e.message}`, 'red', 'error');
                console.error("[WS] Error sending resize:", e);
            }
        }
    }

    // --- Funzione per Disconnessione Manuale ---
    function disconnectWebSocket(reason = "User action") {
         logWs(`Disconnessione WebSocket richiesta. Reason: ${reason}`, 'orange');
         explicitDisconnect = true; // Imposta il flag per prevenire riconnessione
         if (ws) {
             logWs(`Chiusura WebSocket con codice 1000.`, 'gray');
             ws.onclose = null; // Rimuovi il gestore standard per evitare riconnessione
             ws.onerror = null;
             ws.close(1000, reason); // 1000 = Chiusura normale e voluta
             ws = null;
         } else {
              logWs("Nessuna connessione WebSocket attiva da chiudere.", 'gray');
         }
         resetReconnectState(); // Pulisci stato riconnessione
         if(extDisposeListeners) extDisposeListeners(); // Scollega listener terminale
         extWsStatusUpdateFn('disconnected'); // Aggiorna UI
         extUnblockShellButtonFn(false); // Sblocca bottone
    }

    // --- Funzione Helper --- (Correzione Problema 2)
    function isConnected() {
        return ws !== null && ws.readyState === WebSocket.OPEN;
    }

    // --- Esporta l'API del Modulo ---
    window.WebSocketManager = {
        connectWebSocket,
        disconnectWebSocket,
        sendTerminalData,
        sendTerminalResize,
        setExternalDependencies,
        isConnected // Esporta la funzione isConnected
    };

    logWs('Modulo WebSocketManager caricato e inizializzato.', 'gray');

})(); // Fine IIFE
