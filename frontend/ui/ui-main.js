// page/js/ui-main.js
// Inizializzazione principale, riferimenti DOM, collegamento eventi

(function(SyntraUI) {
    'use strict';

    let domReady = false;

    function initDOMReferences() {
        const localRefs = {};

        localRefs.appContainer = document.querySelector('.app-container');
        localRefs.usernameInput = document.getElementById('username');
        localRefs.passwordInput = document.getElementById('password');
        localRefs.userEthAddressEl = document.getElementById('userEthAddress');
        localRefs.signupButton = document.getElementById('signupButton');
        localRefs.loginButton = document.getElementById('loginButton');
        localRefs.logoutButton = document.getElementById('logoutButton');
        localRefs.configureSubButton = document.getElementById('configureSubButton');
        localRefs.checkSubsButton = document.getElementById('checkSubsButton');
        localRefs.subscriptionSelect = document.getElementById('availableSubscriptions');
        localRefs.openShellButton = document.getElementById('openShellButton');
        localRefs.launchControl = document.getElementById('launch-control');
        localRefs.authSection = document.getElementById('auth-section');
        localRefs.dashboardSection = document.getElementById('dashboard-section');
        localRefs.terminalContainer = document.getElementById('terminal-container');
        localRefs.terminalElement = document.getElementById('terminal');
        localRefs.wsStatusEl = document.getElementById('ws-status');
        localRefs.subscribeDialog = document.getElementById('subscribe-dialog');
        localRefs.cancelSubButton = document.getElementById('cancelSubButton');
        localRefs.confirmSubButton = document.getElementById('confirmSubButton');
        localRefs.selectImageButton = document.getElementById('selectImageButton');
        localRefs.imageSelectDialog = document.getElementById('image-select-dialog');
        localRefs.cancelImageSelect = document.getElementById('cancelImageSelect');
        localRefs.imageGrid = localRefs.imageSelectDialog?.querySelector('.image-grid');
        localRefs.subCpuRange = document.getElementById('subCpuRange');
        localRefs.subCpuOutput = document.getElementById('subCpuOutput');
        localRefs.subRamRange = document.getElementById('subRamRange');
        localRefs.subRamOutput = document.getElementById('subRamOutput');
        localRefs.subStorageRange = document.getElementById('subStorageRange');
        localRefs.subStorageOutput = document.getElementById('subStorageOutput');
        localRefs.subDurationInput = document.getElementById('subDurationInput');
        localRefs.subReplicasInput = document.getElementById('subReplicasInput');
        localRefs.selectedImageNameEl = document.getElementById('selected-image-name');
        localRefs.loadingOverlay = document.getElementById('loading-overlay');
        localRefs.authMessagesEl = document.getElementById('auth-messages');
        localRefs.dashboardMessagesEl = document.getElementById('dashboard-messages');
        localRefs.toastContainer = document.getElementById('toast-container');
        localRefs.closeTerminalButton = document.getElementById('closeTerminalButton');

        SyntraUI.refs = localRefs;

        const essentialKeys = ['appContainer', 'authSection', 'dashboardSection', 'terminalContainer', 'loginButton', 'terminalElement', 'closeTerminalButton', 'launchControl', 'loadingOverlay', 'imageSelectDialog', 'imageGrid', 'selectImageButton', 'selectedImageNameEl'];
        let missing = false;
        essentialKeys.forEach(key => {
            if (!SyntraUI.refs[key]) {
                 missing = true;
            }
        });

        if (missing) {
             return false;
        }
        return true;
    }

    function attachEventListeners() {
        const uiRefs = SyntraUI.refs;

        if (uiRefs?.loginButton && typeof SyntraUI.onLoginClick === 'function') {
            uiRefs.loginButton.addEventListener('click', SyntraUI.onLoginClick);
        }

        uiRefs?.signupButton?.addEventListener('click', SyntraUI.onSignupClick);
        uiRefs?.logoutButton?.addEventListener('click', SyntraUI.onLogoutClick);
        uiRefs?.configureSubButton?.addEventListener('click', SyntraUI.onConfigureSubClick);
        uiRefs?.checkSubsButton?.addEventListener('click', SyntraUI.onCheckSubsClick);
        uiRefs?.openShellButton?.addEventListener('click', SyntraUI.onOpenShellClick);
        uiRefs?.closeTerminalButton?.addEventListener('click', SyntraUI.onCloseTerminalClick);

        uiRefs?.confirmSubButton?.addEventListener('click', SyntraUI.onConfirmSubClick);
        if (typeof SyntraUI.closeSubscribeDialog === 'function') {
            uiRefs?.cancelSubButton?.addEventListener('click', SyntraUI.closeSubscribeDialog);
        }

        uiRefs?.selectImageButton?.addEventListener('click', SyntraUI.openImageSelectDialog);
        if (typeof SyntraUI.closeImageSelectDialog === 'function') {
            uiRefs?.cancelImageSelect?.addEventListener('click', SyntraUI.closeImageSelectDialog);
        }

        if (typeof SyntraUI.handleSliderUpdate === 'function') {
            uiRefs?.subCpuRange?.addEventListener('input', SyntraUI.handleSliderUpdate);
            uiRefs?.subRamRange?.addEventListener('input', SyntraUI.handleSliderUpdate);
            uiRefs?.subStorageRange?.addEventListener('input', SyntraUI.handleSliderUpdate);
        }

        if (uiRefs?.imageGrid && typeof SyntraUI.handleImageCardSelect === 'function') {
            uiRefs.imageGrid.addEventListener('click', (event) => {
                const selectButton = event.target.closest('.select-image-btn');
                if (selectButton) {
                    SyntraUI.handleImageCardSelect(event);
                }
            });
        }
    }

    function initializeUI() {
        if (!domReady) return;
        try {
             if (!window.SyntraUI) throw new Error("Oggetto globale SyntraUI non creato!");

             const essentialFunctions = ['setupTerminal', 'updateWsStatus', 'showToast', 'setButtonLoading', 'hideLoading', 'logDashboardMsg', 'showErr',
                                         'disposeTermListeners', 'reattachTerminalListeners', 'resetLoginState', 'onLoginClick', 'onSignupClick',
                                         'onLogoutClick', 'onConfigureSubClick', 'onCheckSubsClick', 'onOpenShellClick', 'onCloseTerminalClick',
                                         'onConfirmSubClick', 'openImageSelectDialog', 'closeSubscribeDialog', 'closeImageSelectDialog',
                                         'handleSliderUpdate', 'handleImageCardSelect'];
             essentialFunctions.forEach(fnName => {
                 if (typeof SyntraUI[fnName] !== 'function') {
                     // Potrebbe essere un errore critico a seconda della funzione
                 }
             });

            if (!initDOMReferences()) {
                 throw new Error("Inizializzazione riferimenti DOM fallita.");
            }

            if (typeof SyntraUI.setupTerminal === 'function') {
                 if (!SyntraUI.setupTerminal()) {
                     throw new Error("Setup Terminal fallito.");
                 }
            }

            if (window.WebSocketManager) {
                if (typeof SyntraUI.termInstance === 'object' && typeof SyntraUI.logDashboardMsg === 'function' && typeof SyntraUI.showErr === 'function' &&
                    typeof SyntraUI.disposeTermListeners === 'function' && typeof SyntraUI.reattachTerminalListeners === 'function' && typeof SyntraUI.setButtonLoading === 'function' && typeof SyntraUI.hideLoading === 'function')
                {
                    window.WebSocketManager.setExternalDependencies(
                        SyntraUI.termInstance,
                        SyntraUI.logDashboardMsg,
                        SyntraUI.showErr,
                        SyntraUI.disposeTermListeners,
                        SyntraUI.reattachTerminalListeners,
                        () => {
                            const btn = SyntraUI.refs?.openShellButton;
                             if(btn) {
                                SyntraUI.setButtonLoading(btn, false);
                                btn.disabled = !SyntraUI.refs?.subscriptionSelect?.value;
                             }
                            SyntraUI.hideLoading();
                        },
                        () => {
                             const btn = SyntraUI.refs?.openShellButton;
                             if(btn) SyntraUI.setButtonLoading(btn, true);
                         },
                         () => {
                             SyntraUI.hideLoading();
                             const btn = SyntraUI.refs?.openShellButton;
                             if(btn) SyntraUI.setButtonLoading(btn, false);
                         }
                    );
                }
            } else {
                if (SyntraUI.refs?.openShellButton) SyntraUI.refs.openShellButton.disabled = true;
                 if (SyntraUI.updateWsStatus) SyntraUI.updateWsStatus(false);
            }

            attachEventListeners();

             if (typeof SyntraUI.resetLoginState === 'function') {
                 SyntraUI.resetLoginState();
             }

        } catch (error) {
          
                 if (SyntraUI.refs?.dashboardMessagesEl) {
                     SyntraUI.refs.dashboardMessagesEl.innerHTML = `<p class="error-message">Errore Critico UI: ${error.message}. Ricarica o controlla console (F12).</p>`;
                     SyntraUI.refs.dashboardMessagesEl.style.display = 'block';
                 } else if (SyntraUI.showToast) {
                      SyntraUI.showToast(`Errore Critico UI: ${error.message}. Controlla console (F12).`, 'error', 10000);
                 } else {
                     document.body.innerHTML = `<div style="position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; background: #111; color: red; padding: 20px; font-family: sans-serif; font-size: 1.2em; border: 2px solid red; z-index: 9999;"><h1>Errore Critico Caricamento UI</h1><p>Dettaglio: ${error.message}</p><p>Controlla la console del browser (F12) per maggiori informazioni.</p></div>`;
                 }
           
        }
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => { domReady = true; initializeUI(); }); }
    else { domReady = true; initializeUI(); }

    window.addEventListener('beforeunload', () => {
        if (window.WebSocketManager && typeof window.WebSocketManager.disconnectWebSocket === 'function') {
            window.WebSocketManager.disconnectWebSocket("Navigating away");
        }

        if (SyntraUI.disposeTermListeners && typeof SyntraUI.disposeTermListeners === 'function') {
            SyntraUI.disposeTermListeners();
        }
    });

    window.AppPublicUI = {
        reattachTerminalListeners: SyntraUI.reattachTerminalListeners,
        updateWsStatus: SyntraUI.updateWsStatus,
        showToast: SyntraUI.showToast,
        setButtonLoading: SyntraUI.setButtonLoading,
        hideLoading: SyntraUI.hideLoading,
        logDashboardMsg: SyntraUI.logDashboardMsg,
        onCloseTerminalClick: SyntraUI.onCloseTerminalClick
    };

}(window.SyntraUI = window.SyntraUI || {}));