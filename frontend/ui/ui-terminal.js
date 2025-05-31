// js/ui-terminal.js
// Gestione specifica di xterm.js, basata sulla documentazione ufficiale
// Docs: https://xtermjs.org/docs/

(function(SyntraUI) {
    'use strict';

    // Alias per log standardizzato
    const logTerm = (message, color = '', level = 'log') => {
        const timestamp = new Date().toLocaleTimeString();
        const style = color ? `color:${color}` : '';
        // Assumiamo che SyntraUI.logDashboardMsg o una funzione simile esista
        if (SyntraUI.logDashboardMsg) {
            SyntraUI.logDashboardMsg(`[${timestamp}][Terminal] ${message}`, color, level);
        } else {
            console[level](`[${timestamp}][Terminal] ${message}`);
        }
    };

    // --- Inizializzazione Terminale e Addons ---
    // Come da documentazione: https://xtermjs.org/docs/api/terminal/classes/terminal/
    logTerm('Inizializzazione istanza Terminal e Addons...', 'gray');
    const term = new Terminal({
        cursorBlink: true,
        scrollback: 1000,
        tabStopWidth: 4,
        convertEol: true, // Converte newline in \r\n (utile per PTY)
        theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: 'rgba(57, 197, 207, 0.7)', selectionBackground: 'rgba(57, 197, 207, 0.2)' },
        fontSize: 15,
        fontFamily: 'Rajdhani, Menlo, Monaco, "Courier New", monospace',
        allowProposedApi: true, // Necessario per alcuni addon o feature avanzate
        // Imposta un livello di log interno di xterm (opzionale, utile per debug profondo)
        // logLevel: 'debug', // Opzioni: 'debug', 'info', 'warn', 'error', 'off'
    });

    // Addons comuni: https://xtermjs.org/docs/guides/addons/
    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();

    // Variabili per gestire i listener (per poterli rimuovere)
    let termDataListener = null;
    let termResizeListener = null;
    let resizeTimeout = null;

    // Esponi istanze globalmente se servono ad altri moduli (es. WebSocketManager)
    SyntraUI.termInstance = term;
    SyntraUI.fitAddonInstance = fitAddon;
    logTerm('Istanza Terminal e FitAddon esposte su SyntraUI.', 'gray');

    // --- Setup e Apertura Terminale ---
    SyntraUI.setupTerminal = function() {
        logTerm('setupTerminal START', 'cyan');
        const terminalElement = SyntraUI.refs?.terminalElement; // Riferimento dal DOM
        if (!terminalElement) {
            logTerm("Elemento DOM #terminal non trovato!", 'red', 'error');
            return false;
        }
        try {
            // Carica addons prima di aprire: https://xtermjs.org/docs/api/terminal/classes/terminal/#loadaddon
            logTerm('Caricamento FitAddon...', 'gray');
            term.loadAddon(fitAddon);
            logTerm('Caricamento WebLinksAddon...', 'gray');
            term.loadAddon(webLinksAddon);

            // Apri il terminale nell'elemento designato: https://xtermjs.org/docs/api/terminal/classes/terminal/#open
            logTerm(`Apertura terminale nell'elemento #${terminalElement.id}...`, 'gray');
            term.open(terminalElement);
            logTerm("Terminale aperto con successo.", 'lime');

            // Aggiungi listener per il resize della finestra (gestisce fit)
            window.addEventListener('resize', handleWindowResize);
            logTerm("Listener 'resize' della finestra aggiunto.", 'gray');

            // Fit iniziale (opzionale, potrebbe essere meglio farlo quando la view diventa attiva)
            // requestAnimationFrame(() => { fitAddon.fit(); });

            logTerm('setupTerminal END (Success)', 'cyan');
            return true;
        } catch(e) {
             logTerm(`Errore setupTerminal: ${e.message}`, 'red', 'error');
             console.error("Error setupTerminal:", e);
             logTerm('setupTerminal END (Failure - Exception)', 'red', 'error');
             return false;
        }
    }

    // --- Gestione Resize ---
    function handleWindowResize() {
         clearTimeout(resizeTimeout);
         resizeTimeout = setTimeout(() => {
             try {
                 // Esegui fit() solo se il terminale è effettivamente visibile
                 if (SyntraUI.refs?.appContainer?.dataset.activeView === 'terminal' && term.element) {
                    logTerm('Finestra ridimensionata, esecuzione fitAddon.fit()...', 'gray');
                    fitAddon.fit(); // Adatta dimensioni del terminale
                    // Invia le nuove dimensioni al backend (se connesso)
                    if (window.WebSocketManager?.isConnected()) {
                        logTerm(`Invio nuove dimensioni PTY (${term.cols}x${term.rows}) via WS...`, 'gray');
                        window.WebSocketManager.sendTerminalResize(term.cols, term.rows);
                    }
                }
             } catch (e) {
                logTerm(`Errore FitAddon durante resize: ${e.message}`, 'orange', 'warn');
             }
         }, 150); // Debounce per evitare troppe chiamate ravvicinate
    }
    SyntraUI.handleWindowResize = handleWindowResize; // Esponi se serve rimuoverlo

    // --- Collegamento Listener Input/Output (Cruciale!) ---
    // Questa funzione DEVE essere chiamata DOPO che la connessione WebSocket è stabilita
    SyntraUI.attachTerminalListeners = function() {
         logTerm('attachTerminalListeners START', 'yellow');
         SyntraUI.disposeTermListeners(); // Buona pratica: rimuovi sempre i vecchi prima di aggiungerne nuovi

         if (!term) {
             logTerm("Impossibile collegare listener, istanza terminale mancante!", 'red', 'error');
             return;
         }
         logTerm("Tentativo collegamento listeners onData e onResize...", 'gray');
         try {
             // --- Listener INPUT UTENTE (term -> backend) ---
             // https://xtermjs.org/docs/api/terminal/interfaces/iterminaladdons/#ondata
             logTerm('   Collegamento term.onData...', 'gray');
             termDataListener = term.onData(data => {
                 // logTerm(`onData FIRED! Dati: "${JSON.stringify(data)}"`, 'lime'); // Logga TUTTO l'input
                 if (window.WebSocketManager && window.WebSocketManager.isConnected()) {
                    // Invia i dati grezzi al backend tramite WebSocket
                    window.WebSocketManager.sendTerminalData(data);
                 } else {
                    // Se non connesso, l'input non va da nessuna parte
                    logTerm('   [onData] WebSocket non connesso. Input IGNORATO.', 'orange', 'warn');
                 }
             });
             if (termDataListener) { logTerm('   term.onData COLLEGATO.', 'lime'); }
             else { logTerm('   FALLIMENTO collegamento term.onData!', 'red', 'error'); }

             // --- Listener RESIZE (frontend -> backend) ---
             // https://xtermjs.org/docs/api/terminal/interfaces/iterminaladdons/#onresize
             logTerm('   Collegamento term.onResize...', 'gray');
             termResizeListener = term.onResize(({ cols, rows }) => {
                 logTerm(`onResize FIRED! Nuove dimensioni: ${cols}x${rows}`, 'lime');
                 if (window.WebSocketManager?.isConnected() && SyntraUI.refs?.appContainer?.dataset.activeView === 'terminal') {
                    logTerm(`   Invio resize PTY (${cols}x${rows}) via WS...`, 'gray');
                    window.WebSocketManager.sendTerminalResize(cols, rows);
                 }
             });
             if (termResizeListener) { logTerm('   term.onResize COLLEGATO.', 'lime'); }
             else { logTerm('   FALLIMENTO collegamento term.onResize!', 'red', 'error'); }

             // --- Invio dimensioni iniziali al backend ---
             // È buona norma inviare le dimensioni subito dopo la connessione e l'attach dei listener
             requestAnimationFrame(() => {
                 if (window.WebSocketManager?.isConnected() && SyntraUI.refs?.appContainer?.dataset.activeView === 'terminal') {
                     logTerm(`Invio dimensioni PTY iniziali (${term.cols}x${term.rows}) via WS...`, 'gray');
                     window.WebSocketManager.sendTerminalResize(term.cols, term.rows);
                 }
             });

             // --- Dare il FOCUS al terminale ---
             // Cruciale per ricevere l'input da tastiera
             // https://xtermjs.org/docs/api/terminal/classes/terminal/#focus
             logTerm('   Tentativo di dare focus al terminale...', 'yellow');
             SyntraUI.focusTerminal(); // Chiama la funzione separata per il focus

             logTerm('attachTerminalListeners END (Success)', 'yellow');

         } catch(e) {
              logTerm(`Errore durante il collegamento dei listener: ${e.message}`, 'red', 'error');
              console.error("Error attaching terminal listeners:", e);
              logTerm('attachTerminalListeners END (Failure - Exception)', 'red', 'error');
         }
    }

   SyntraUI.reattachTerminalListeners = function() {
    SyntraUI.disposeTermListeners();            // <-- questa riga è fondamentale!
    SyntraUI.attachTerminalListeners();         // <-- poi riattacca senza rischio di duplicati
};    // --- Scollegamento Listener ---
    SyntraUI.disposeTermListeners = function() {
        logTerm('disposeTermListeners START', 'orange');
        let disposed = false;
        try {
            // Usa IDisposable.dispose(): https://xtermjs.org/docs/api/terminal/interfaces/idisposable/
            if (termDataListener) {
                termDataListener.dispose();
                termDataListener = null;
                logTerm('   Listener onData scollegato.', 'gray');
                disposed = true;
            }
            if (termResizeListener) {
                termResizeListener.dispose();
                termResizeListener = null;
                logTerm('   Listener onResize scollegato.', 'gray');
                disposed = true;
            }
            if (!disposed) { logTerm('   Nessun listener attivo da scollegare.', 'gray'); }
            logTerm('disposeTermListeners END', 'orange');
        } catch(e) {
             logTerm(`Errore durante disposeTermListeners: ${e.message}`, 'red', 'error');
             console.warn("Error disposing terminal listeners:", e);
        }
    }

    // --- Funzioni Utilità Terminale ---

    SyntraUI.clearTerminal = function() {
        logTerm('clearTerminal chiamato.', 'gray');
        try {
            // https://xtermjs.org/docs/api/terminal/classes/terminal/#clear
            term?.clear();
        } catch(e) {
            logTerm(`Errore term.clear(): ${e.message}`, 'orange', 'warn');
        }
    }

    SyntraUI.focusTerminal = function() {
        logTerm('focusTerminal chiamato.', 'yellow');
        try {
            // https://xtermjs.org/docs/api/terminal/classes/terminal/#focus
            term?.focus();
            // Verifica opzionale
            if (term?.textarea === document.activeElement) {
                logTerm('   Focus impostato con successo!', 'lime');
            } else {
                // Potrebbe essere normale se un altro elemento prende il focus subito dopo
                logTerm('   Focus NON verificato su textarea (document.activeElement diverso).', 'gray', 'warn');
            }
        } catch(e) {
            logTerm(`Errore term.focus(): ${e.message}`, 'orange', 'warn');
        }
    }

    // Funzione per scrivere dati RICEVUTI dal backend sul terminale
    SyntraUI.writeToTerminal = function(message) {
         try {
             // Usa term.write() per l'output dal backend PTY
             // https://xtermjs.org/docs/api/terminal/classes/terminal/#write
             // Evita term.writeln() a meno che non sia intenzionale aggiungere un newline extra
             term?.write(message);
         } catch(e) {
              logTerm(`Errore term.write(): ${e.message}`, 'orange', 'warn');
         }
    }

}(window.SyntraUI = window.SyntraUI || {}));
