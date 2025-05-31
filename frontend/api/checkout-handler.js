// checkout-handler.js

// Assicurati che le funzioni logMsg, showErr e la costante BASE_URL
// definite in index.html siano accessibili globalmente o passale/importale
// se stai usando moduli ES6. Qui assumiamo che siano globali.

/**
 * Controlla i parametri URL al caricamento della pagina per gestire
 * i ritorni da Stripe Checkout.
 */
function handleCheckoutReturn() {
    console.log("[Checkout Handler] Checking URL parameters...");
    const urlParams = new URLSearchParams(window.location.search);
    const checkoutStatus = urlParams.get('checkout_status');
    const sessionId = urlParams.get('session_id');

    // Pulisci i parametri dall'URL per evitare ri-esecuzioni al refresh
    if (checkoutStatus) {
        console.log(`[Checkout Handler] Found status: ${checkoutStatus}`);
        // Usa history.replaceState per rimuovere i parametri senza ricaricare la pagina
        const cleanUrl = window.location.pathname; // Ottiene solo il path senza query string
        try {
            window.history.replaceState(null, '', cleanUrl);
            console.log("[Checkout Handler] Cleaned URL parameters.");
        } catch (e) {
            console.warn("[Checkout Handler] Could not clean URL parameters:", e);
        }
    }

    if (checkoutStatus === 'success' && sessionId) {
        console.log(`[Checkout Handler] Payment Success detected for session: ${sessionId}`);
        // Mostra un messaggio all'utente
        if (typeof logMsg === 'function') {
            logMsg(`Pagamento riuscito (Session ID: ${sessionId}). Conferma azione in corso...`, "cyan");
        } else {
            console.warn("Funzione logMsg non trovata.");
            alert(`Pagamento riuscito (Session ID: ${sessionId}). Conferma azione in corso...`);
        }
        // Chiama il backend per confermare e eseguire l'azione
        confirmBackendAction(sessionId);

    } else if (checkoutStatus === 'cancel') {
        console.log(`[Checkout Handler] Payment Cancelled detected for session: ${sessionId || 'N/A'}`);
        if (typeof logMsg === 'function') {
            logMsg("Pagamento annullato dall'utente.", "orange");
        } else {
            console.warn("Funzione logMsg non trovata.");
            alert("Pagamento annullato.");
        }
        // Potresti voler fare altre azioni qui, tipo re-enable di qualche bottone
    } else {
        console.log("[Checkout Handler] No relevant checkout status found in URL.");
    }
}

/**
 * Chiama l'endpoint /confirm-payment sul backend per finalizzare
 * l'azione dopo un pagamento Stripe riuscito.
 * @param {string} sessionId L'ID della sessione di checkout Stripe.
 */
async function confirmBackendAction(sessionId) {
    // Assicurati che BASE_URL sia definita e accessibile
    if (typeof BASE_URL === 'undefined') {
        console.error("[Checkout Handler] BASE_URL non è definita!");
        if(typeof showErr === 'function') showErr("Configurazione Frontend", "BASE_URL non definita.");
        return;
    }
    // Assicurati che axios sia disponibile
    if (typeof axios === 'undefined') {
        console.error("[Checkout Handler] Libreria Axios non trovata!");
         if(typeof showErr === 'function') showErr("Errore Frontend", "Libreria Axios mancante.");
        return;
    }

    const confirmUrl = `${BASE_URL}/confirm-payment`;
    console.log(`[Checkout Handler] Calling backend confirmation: ${confirmUrl} with session ID: ${sessionId}`);

    try {
        const response = await axios.post(confirmUrl, { sessionId: sessionId }, {
             headers: { "Content-Type": "application/json" }
             // Non servono credenziali qui (username/password) perché
             // la sessione Stripe è l'autorizzazione per questa specifica azione.
             // Il backend DEVE verificare la sessione con Stripe.
        });

        console.log("[Checkout Handler] Backend confirmation response:", response.data);

        if (response.data && response.data.success) {
            let successMessage = response.data.message || "Azione confermata con successo!";
            if (response.data.transactionHash) {
                successMessage += ` Hash Transazione: ${response.data.transactionHash}`;
                // Potresti voler mostrare un link a un explorer qui
            }
            if (typeof logMsg === 'function') {
                logMsg(successMessage, "lime");
                // Potrebbe essere utile aggiornare lo stato dell'UI,
                // ad esempio richiamando checkAndListSubscriptions() dopo un po'
                // setTimeout(checkAndListSubscriptions, 3000); // Esempio
            } else {
                 alert(successMessage);
            }
        } else {
            // Il backend ha risposto ma ha indicato un fallimento
             throw new Error(response.data.message || "Il backend ha riportato un errore durante la conferma.");
        }
    } catch (error) {
        console.error("[Checkout Handler] Error during backend confirmation:", error);
        if (typeof showErr === 'function') {
            // Passa l'oggetto errore originale a showErr se può gestirlo
            showErr("Errore Conferma Post-Pagamento", error);
        } else {
            alert(`Errore durante la conferma dell'azione: ${error.message || 'Errore sconosciuto'}`);
        }
    }
}

// Esegui il controllo quando lo script viene caricato e il DOM è pronto.
// Se questo script è caricato alla fine del body o con 'defer',
// il DOM dovrebbe essere pronto. Altrimenti, usa DOMContentLoaded.
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleCheckoutReturn);
} else {
    handleCheckoutReturn(); // DOM già pronto
}