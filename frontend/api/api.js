// api.js

// Definizioni Costanti API (potrebbero venire da un file config separato in futuro)
const BASE_URL_AUTH = 'http://localhost:4004'; // Backend autenticazione/contratto
const BASE_URL_SERVER = `http://localhost:5501`; // Server Express (per API sessioni/immagini)

const CONTRACT_NAME = "SyntraNetPodV2";
const CONTRACT_ADDRESS = "0x8c04b4B2db4bC0C6862f9d4543Bf5D3eDACfAF25";

// --- Helper ---
function getApiAuthHeaders() {
    return {
        "Content-Type": "application/json",
        "User-Agent": "SyntraNetClient/1.0",
        "bypass-tunnel-reminder": "true" // Utile per ngrok/localtunnel
    };
}

// --- Funzioni API ---

async function doSignup(username, password, logFn, errorFn) {
    if (!username || !password) { logFn("Inserisci username e password per Signup.", "yellow"); return null; }
    try {
        logFn("Signup in corso...");
        const url = `${BASE_URL_AUTH}/signup`;
        const resp = await axios.post(url, { username, password }, { headers: getApiAuthHeaders() });
        logFn(`Signup successo: ${resp.data.message || JSON.stringify(resp.data)}`, "lime");
        return { success: true, data: resp.data };
    } catch (err) {
        errorFn("Signup fallito", err);
        return { success: false, error: err };
    }
}

async function doLogin(username, password, logFn, errorFn) {
    if (!username || !password) { logFn("Inserisci username e password per Login.", "yellow"); return null; }
    logFn("Login in corso...");
    try {
        const url = `${BASE_URL_AUTH}/login`;
        const resp = await axios.post(url, { username, password }, { headers: getApiAuthHeaders() });
        const userAddress = resp.data.address || resp.data.ethAddress || resp.data.userAddress;
        if (userAddress?.startsWith('0x')) {
            logFn(`Login successo per ${username}.`, "lime");
            return { success: true, address: userAddress };
        } else {
            logFn("Login OK, ma indirizzo ETH non trovato o non valido.", "orange");
            return { success: false, error: "Indirizzo ETH non valido nella risposta." };
        }
    } catch (err) {
        errorFn("Login fallito", err);
        return { success: false, error: err };
    }
}

async function checkSubscriptionsAPI(username, password, userAddress, logFn, errorFn) {
    logFn(`Verifica sottoscrizioni pod per ${userAddress}...`, "cyan");
    try {
        const requestBody = {
            username: username,
            password: password,
            contractName: CONTRACT_NAME,
            contractAddress: CONTRACT_ADDRESS,
            method: "getSubscriptions",
            args: [userAddress]
        };
        const apiUrl = `${BASE_URL_AUTH}/ZKAASyntraCallStripe2`;
        logFn(`Chiamata API: ${requestBody.method} a ${apiUrl}...`, "gray");

        const response = await axios.post(apiUrl, requestBody, { headers: getApiAuthHeaders(), timeout: 20000 });

        logFn("[API] Dati grezzi ricevuti:", 'gray');
        console.log("[API Response RAW]:", response.data);

        const rawResult = response.data?.result;

        if (!Array.isArray(rawResult)) {
            logFn("[API Warn] Risposta API non contiene un array 'result'.", 'orange');
            console.warn("[API] Dati ricevuti non validi:", response.data);
            return { success: false, subscriptions: [], error: "Formato risposta API inatteso (no result array)" };
        }

        logFn(`[API Info] Trovati ${rawResult.length} record grezzi. Inizio trasformazione...`, 'gray');
        const transformedSubscriptions = rawResult.map((subArray, index) => {
            if (!Array.isArray(subArray) || subArray.length < 10) {
                logFn(`[API Warn] Record grezzo ${index} non è un array valido o ha lunghezza insufficiente (${subArray?.length || 'N/A'}). Saltato.`, 'orange');
                console.warn(`[API Skipping Record ${index}]:`, subArray);
                return null;
            }
            try {
                const transformed = {
                    address:    subArray[1],
                    start_time: subArray[2],
                    end_time:   subArray[3],
                    duration:   subArray[4],
                    replicas:   subArray[5],
                    cpu:        subArray[6],
                    ram:        subArray[7],
                    storage:    subArray[8],
                    sub_id:     subArray[9]?.toString(),
                    // Placeholder status - DEVE ESSERE CORRETTO NEL BACKEND
                    status:     'active'
                };
                 if (!transformed.sub_id || isNaN(parseInt(transformed.start_time)) || isNaN(parseInt(transformed.end_time))) {
                     logFn(`[API Warn] Record trasformato ${index} (ID: ${transformed.sub_id}) ha dati essenziali mancanti o non validi (start/end/id). Saltato.`, 'orange');
                     console.warn(`[API Skipping Invalid Transformed Record ${index}]:`, transformed, subArray);
                     return null;
                 }
                return transformed;
            } catch (transformError) {
                 logFn(`[API Error] Errore durante la trasformazione del record ${index}. Saltato.`, 'red');
                 console.error(`[API Transformation Error Record ${index}]:`, transformError, subArray);
                 return null;
            }
        }).filter(sub => sub !== null);

        logFn(`[API Info] Trasformazione completata. ${transformedSubscriptions.length} sottoscrizioni valide pronte per la UI.`, 'lime');
        return { success: true, subscriptions: transformedSubscriptions };

    } catch (error) {
        logFn("[API Error] Errore durante la chiamata checkSubscriptionsAPI.", 'red');
        console.error("[API Catch Block]:", error);
        const errorMsg = error.response?.data?.message || error.message || "Errore di rete o sconosciuto";
        errorFn("Errore Verifica Sottoscrizioni", errorMsg);
        return { success: false, subscriptions: [], error: errorMsg };
    }
}

async function subscribePodSlotAPI(username, password, subDetails, logFn, errorFn) {
    const { durationSec, replicas, cpu, ram, storage } = subDetails;
    logFn(`Invio richiesta sottoscrizione per ${replicas}x(${cpu}m CPU, ${ram}Mi RAM, ${storage}Gi Sto) per ${durationSec}s...`, "cyan");

    try {
        const requestBodyPrice = {
            username: username, password: password, contractName: CONTRACT_NAME, contractAddress: CONTRACT_ADDRESS,
            method: "getSubscribe_price",
            args: [durationSec, replicas, cpu, ram, storage]
        };
        const apiUrl = `${BASE_URL_AUTH}/ZKAASyntraCallStripe2`;
        const initialResponse = await axios.post(apiUrl, requestBodyPrice, { headers: getApiAuthHeaders() });
        console.log('[API] Raw initialResponse.data:', initialResponse.data);

        if (initialResponse.data?.transactionHash) {
             logFn(`Sottoscrizione ESEGUITA DIRETTAMENTE (Tx: ${initialResponse.data.transactionHash}). ${initialResponse.data.message || ''}`, "lime");
             return { success: true, directTransaction: true, data: initialResponse.data };
        }
        else if (initialResponse.data?.sessionUrl) {
             logFn("Pagamento richiesto tramite Stripe (dalla chiamata 'price'?). Reindirizzamento...", "yellow");
             return { success: false, stripeRedirect: true, url: initialResponse.data.sessionUrl };
        }
        else {
            const potentialPriceValue = initialResponse.data?.result || initialResponse.data;
            let expectedWeiBigInt;
            try {
                 if (typeof potentialPriceValue === 'object' && potentialPriceValue !== null) throw new Error(`Valore ricevuto non è prezzo valido (oggetto): ${JSON.stringify(potentialPriceValue)}`);
                 expectedWeiBigInt = BigInt(potentialPriceValue);
                 const ethPrice = parseFloat(expectedWeiBigInt) / 1e18;
                 logFn(`Prezzo: ${expectedWeiBigInt.toString()} Wei (~${ethPrice.toFixed(6)} ETH). Invio sottoscrizione effettiva...`, "cyan");
            } catch (conversionError) {
                 throw new Error(`Impossibile interpretare prezzo da API (${typeof potentialPriceValue}). Dettagli: ${conversionError.message}. Risposta: ${JSON.stringify(initialResponse.data)}`);
            }

            const subscribeBody = {
                username: username, password: password, contractName: CONTRACT_NAME, contractAddress: CONTRACT_ADDRESS,
                method: "subscribe",
                args: [durationSec, replicas, cpu, ram, storage],
            };
            const subscribeResponse = await axios.post(apiUrl, subscribeBody, { headers: getApiAuthHeaders() });
            console.log('[API] Raw subscribe response data:', subscribeResponse.data);

            if (subscribeResponse.data?.success || subscribeResponse.data?.transactionHash) {
                logFn(`Sottoscrizione inviata (Tx: ${subscribeResponse.data.transactionHash || 'N/A'}). ID: ${subscribeResponse.data?.subscriptionId || subscribeResponse.data?.result || 'N/A'}. Attesa approvazione.`, "lime");
                return { success: true, directTransaction: false, data: subscribeResponse.data };
            } else if (subscribeResponse.data?.sessionUrl) {
                logFn("Pagamento richiesto tramite Stripe. Reindirizzamento...", "yellow");
                return { success: false, stripeRedirect: true, url: subscribeResponse.data.sessionUrl };
            } else {
                logFn(`Risposta Sottoscrizione (seconda chiamata) incerta/fallita: ${JSON.stringify(subscribeResponse.data)}`, "orange");
                 return { success: false, error: subscribeResponse.data };
            }
        }
    } catch (err) {
        errorFn("Errore durante la sottoscrizione", err);
        return { success: false, error: err };
    }
}

// --- NUOVA FUNZIONE per impostare l'immagine Pod ---
/**
 * Invia il nome dell'immagine selezionata al server Express.
 * @param {string} imageName - Il nome dell'immagine (es. "ubuntu:latest").
 * @param {function} logFn - Funzione per loggare messaggi UI.
 * @param {function} errorFn - Funzione per mostrare errori UI.
 * @returns {Promise<{success: boolean, error?: any}>}
 */
async function setPodImageAPI(imageName, logFn, errorFn) {
    if (!imageName) {
        logFn("Nome immagine mancante per API setPodImage.", "yellow");
        return { success: false, error: "Nome immagine mancante" };
    }
    logFn(`Invio immagine selezionata (${imageName}) al server...`, "cyan");
    try {
        const url = `${BASE_URL_SERVER}/api/set-pod-image`; // Usa la porta del server Express (5501)
        const resp = await axios.post(url,
            { imageName: imageName }, // Corpo della richiesta JSON
            { headers: getApiAuthHeaders() } // Usa gli stessi header se necessario
        );
        if (resp.data?.success) {
            logFn(`Immagine Pod predefinita aggiornata a ${imageName} sul server.`, "lime");
            return { success: true };
        } else {
            logFn(`Il server ha risposto con errore durante l'aggiornamento dell'immagine: ${resp.data?.error || 'Errore sconosciuto'}`, "orange");
            return { success: false, error: resp.data?.error || "Errore sconosciuto dal server" };
        }
    } catch (err) {
        errorFn("Errore API Imposta Immagine", err); // Mostra errore nella UI
        return { success: false, error: err };
    }
}
// --- Fine Nuova Funzione ---

// Esporta le funzioni per renderle disponibili globalmente tramite window.API
window.API = {
    doSignup,
    doLogin,
    checkSubscriptionsAPI,
    subscribePodSlotAPI,
    setPodImageAPI // Aggiungi la nuova funzione all'export
};
