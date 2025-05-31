// js/ui-auth.js
// Gestione eventi e UI per Autenticazione (Login, Signup, Logout)

(function(SyntraUI) {
    'use strict';

    // --- Gestione Stato UI & Login/Logout ---

    SyntraUI.resetLoginState = function() {
        console.log("[UI Auth] Esecuzione resetLoginState...");
        const refs = SyntraUI.refs;
        const state = SyntraUI.state;

        state.loggedInUserAddress = null;
        state.selectedSubscriptionId = null;
        state.selectedImageName = 'ubuntu:latest';

        SyntraUI.setActiveView('auth'); // Imposta la vista di autenticazione

        refs?.launchControl?.classList.add('hidden'); // Nascondi controllo interno dashboard

        // Reset Campi e Bottoni Auth/Dashboard
        if(refs?.userEthAddressEl) refs.userEthAddressEl.textContent = 'N/A';
        if(refs?.checkSubsButton) { refs.checkSubsButton.disabled = true; SyntraUI.setButtonLoading(refs.checkSubsButton, false); refs.checkSubsButton.title = "Login richiesto"; }
        if(refs?.configureSubButton) { refs.configureSubButton.disabled = true; }
        if(refs?.subscriptionSelect) { refs.subscriptionSelect.innerHTML = '<option value="">-- Verifica richiesta --</option>'; refs.subscriptionSelect.disabled = true; refs.subscriptionSelect.title = "Login e verifica richiesti"; }
        if(refs?.openShellButton) { refs.openShellButton.disabled = true; SyntraUI.setButtonLoading(refs.openShellButton, false); refs.openShellButton.title = "Login, verifica e seleziona"; }
        if (refs?.usernameInput) { refs.usernameInput.value = ''; refs.usernameInput.disabled = false; }
        if (refs?.passwordInput) { refs.passwordInput.value = ''; refs.passwordInput.disabled = false; }
        if (refs?.loginButton) { refs.loginButton.disabled = false; SyntraUI.setButtonLoading(refs.loginButton, false); }
        if (refs?.signupButton) { refs.signupButton.disabled = false; SyntraUI.setButtonLoading(refs.signupButton, false); }

        SyntraUI.logAuthMsg("Pronto. Effettua il login.", "gray");
        SyntraUI.logDashboardMsg("", "gray"); // Pulisci dashboard
        SyntraUI.updateWsStatus('disconnected');

        // Disconnetti WebSocket e pulisci terminale
        if (window.WebSocketManager) window.WebSocketManager.disconnectWebSocket("User logged out or reset state");
        SyntraUI.disposeTermListeners();
        SyntraUI.clearTerminal();
        console.log("[UI Auth] resetLoginState completato.");
    }

    SyntraUI.updateUILoginSuccess = function(address) {
        console.log("[UI Auth] Esecuzione updateUILoginSuccess...");
        const refs = SyntraUI.refs;
        const state = SyntraUI.state;

        state.loggedInUserAddress = address;
        const shortAddress = address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : 'Indirizzo non valido';

        SyntraUI.setActiveView('dashboard'); // Imposta la vista dashboard

        refs?.launchControl?.classList.add('hidden'); // Nascondi launchControl inizialmente

        // Aggiorna Campi e Bottoni Dashboard
        if(refs?.userEthAddressEl) { refs.userEthAddressEl.textContent = shortAddress; refs.userEthAddressEl.title = address; }
        if(refs?.checkSubsButton) { refs.checkSubsButton.disabled = false; SyntraUI.setButtonLoading(refs.checkSubsButton, false); refs.checkSubsButton.title = "Verifica sottoscrizioni"; }
        if(refs?.configureSubButton) { refs.configureSubButton.disabled = false; }
        if(refs?.subscriptionSelect) { refs.subscriptionSelect.innerHTML = '<option value="">-- Verifica Sott. --</option>'; refs.subscriptionSelect.disabled = true; refs.subscriptionSelect.title = "Verifica richiesta"; }
        if(refs?.openShellButton) { refs.openShellButton.disabled = true; SyntraUI.setButtonLoading(refs.openShellButton, false); refs.openShellButton.title = "Verifica e seleziona sottoscrizione"; }

        // Disabilita campi/bottoni login (anche se la sezione è nascosta)
        if (refs?.usernameInput) refs.usernameInput.disabled = true;
        if (refs?.passwordInput) refs.passwordInput.disabled = true;
        if (refs?.loginButton) refs.loginButton.disabled = true;
        if (refs?.signupButton) refs.signupButton.disabled = true;

        SyntraUI.logDashboardMsg(`Login effettuato. Verifica le sottoscrizioni o configurane una nuova.`, "lime");
        SyntraUI.logAuthMsg("", "gray"); // Pulisci area messaggi auth
        console.log("[UI Auth] updateUILoginSuccess completato.");
    }


    // --- Handler Eventi Auth ---

    SyntraUI.onSignupClick = async function(event) {
        const button = event.currentTarget;
        const refs = SyntraUI.refs;
        const username = refs?.usernameInput?.value.trim();
        const password = refs?.passwordInput?.value.trim();

        if (!username || !password) {
            SyntraUI.showToast("Username e Password richiesti", "warning");
            return;
        }
        SyntraUI.setButtonLoading(button, true);
        SyntraUI.logAuthMsg("Signup in corso...", "cyan");
        SyntraUI.showLoading("Registrazione...");

        if (window.API) {
            // Passa le funzioni helper necessarie direttamente
            const result = await window.API.doSignup(username, password, SyntraUI.logAuthMsg, SyntraUI.showErr);
            if (result?.success) {
                SyntraUI.showToast(`Signup successo: ${result.data?.message || 'OK'}`, 'success');
                SyntraUI.logAuthMsg("Signup completato. Effettua Login.", "lime");
            }
            // L'errore è gestito da showErr passato a doSignup
        } else {
            SyntraUI.showErr("Errore", "Modulo API non disponibile");
        }
        SyntraUI.setButtonLoading(button, false);
        SyntraUI.hideLoading();
    }

    SyntraUI.onLoginClick = async function(event) {
        const button = event.currentTarget;
        const refs = SyntraUI.refs;
        const username = refs?.usernameInput?.value.trim();
        const password = refs?.passwordInput?.value.trim();

        if (!username || !password) {
            SyntraUI.showToast("Username e Password richiesti", "warning");
            return;
        }
        SyntraUI.setButtonLoading(button, true);
        SyntraUI.logAuthMsg("Login in corso...", "cyan");
        SyntraUI.showLoading("Login...");

        if (window.API) {
            const result = await window.API.doLogin(username, password, SyntraUI.logAuthMsg, SyntraUI.showErr);
            console.log(">>> [DEBUG Auth] API.doLogin Result:", JSON.stringify(result));
            if (result?.success && result.address) {
                 console.log(">>> [DEBUG Auth] Login Success, calling updateUILoginSuccess");
                SyntraUI.updateUILoginSuccess(result.address); // Chiama la funzione UI corretta
                SyntraUI.showToast(`Login effettuato`, 'success');
            } else {
                 console.warn(">>> [DEBUG Auth] Login Failed or missing data:", result);
                SyntraUI.resetLoginState(); // Torna allo stato di login
                if (!result?.error) { // Mostra messaggio solo se showErr non l'ha già fatto
                    SyntraUI.showToast("Login fallito", 'error');
                    SyntraUI.logAuthMsg("Credenziali errate o problema API?", "red");
                }
            }
        } else {
            SyntraUI.resetLoginState(); // Torna allo stato di login
            SyntraUI.showErr("Errore", "Modulo API non disponibile");
        }
        SyntraUI.setButtonLoading(button, false);
        SyntraUI.hideLoading();
    }

    SyntraUI.onLogoutClick = function() {
        console.log("[UI Auth] Logout requested.");
        SyntraUI.showToast("Logout effettuato.", "info");
        SyntraUI.resetLoginState(); // Chiama la funzione di reset
    }

}(window.SyntraUI = window.SyntraUI || {}));