// js/ui-state.js
// Gestione dello stato UI condiviso e cambio vista

(function(SyntraUI) {
    'use strict';

    // --- Stato UI Condiviso ---
    SyntraUI.state = {
        loggedInUserAddress: null,
        selectedSubscriptionId: null,
        selectedImageName: 'ubuntu:latest' // Default image
        // Aggiungi altri stati condivisi se necessario
    };

    // --- Gestione Cambio Vista ---
    SyntraUI.setActiveView = function(viewName) { // viewName può essere 'auth', 'dashboard', 'terminal'
        const appContainer = SyntraUI.refs?.appContainer;
        const terminalContainer = SyntraUI.refs?.terminalContainer;

        if (appContainer) {
            console.log(`[UI State] Impostazione vista attiva a: ${viewName}`);
            appContainer.dataset.activeView = viewName;

            // Adatta il terminale *solo* quando la sua vista diventa attiva
            if (viewName === 'terminal') {
                requestAnimationFrame(() => {
                     try {
                         // Assicurati che SyntraUI.termInstance e SyntraUI.fitAddonInstance siano disponibili
                         if (SyntraUI.termInstance && SyntraUI.fitAddonInstance && terminalContainer?.offsetParent !== null) {
                            console.log("[UI State] Adattamento terminale su cambio vista...");
                            SyntraUI.fitAddonInstance.fit();
                            SyntraUI.focusTerminal(); // Usa la funzione esposta da ui-terminal
                            // Invia resize se connesso
                            if (window.WebSocketManager?.isConnected()) {
                                window.WebSocketManager.sendTerminalResize(SyntraUI.termInstance.cols, SyntraUI.termInstance.rows);
                             }
                         } else {
                             if (terminalContainer?.offsetParent === null) {
                                 console.warn("[UI State] Tentativo fit su terminale non ancora visibile.");
                             } else {
                                console.warn("[UI State] Impossibile adattare terminale: istanza, addon o contenitore mancante/non visibile.");
                             }
                         }
                    } catch (e) {
                         console.warn("[UI State] Errore durante fitAddon su cambio vista:", e.message);
                    }
                });
            }
        } else {
            console.error("[UI State] App Container non trovato, impossibile cambiare vista.");
        }
    }

    // --- Gestione stato WS Indicator ---
    SyntraUI.updateWsStatus = function(status) { // 'connected', 'connecting', 'disconnected'
        const wsStatusEl = SyntraUI.refs?.wsStatusEl;
        if (wsStatusEl) {
            wsStatusEl.className = 'ws-status-indicator'; // Reset
            wsStatusEl.classList.add(status);
            let title = 'WebSocket: ';
            if (status === 'connected') title += 'Connesso';
            else if (status === 'connecting') title += 'Connessione...';
            else title += 'Disconnesso';
            wsStatusEl.title = title;
        }
   }

}(window.SyntraUI = window.SyntraUI || {}));