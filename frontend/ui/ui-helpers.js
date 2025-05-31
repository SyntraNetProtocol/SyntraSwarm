// js/ui-helpers.js
// Funzioni di utilità generiche per l'interfaccia

(function(SyntraUI) {
    'use strict';

    // Riferimenti DOM (verranno popolati da ui-main.js e messi su SyntraUI)
    // let loadingOverlay = SyntraUI.refs?.loadingOverlay;
    // let toastContainer = SyntraUI.refs?.toastContainer;
    // let authMessagesEl = SyntraUI.refs?.authMessagesEl;
    // let dashboardMessagesEl = SyntraUI.refs?.dashboardMessagesEl;

    // --- Funzioni Helper UI ---
    function logToArea(areaEl, msg, color = "cyan") {
        if (areaEl) {
            areaEl.className = 'message-area'; // Reset classi colore
            if (color) areaEl.classList.add(`color-${color}`);
            areaEl.textContent = msg;
        }
        console.log(`[UI Log ${color}] ${msg}`);
    }

    SyntraUI.logAuthMsg = function(msg, color = "cyan") {
        logToArea(SyntraUI.refs?.authMessagesEl, msg, color);
    }
    SyntraUI.logDashboardMsg = function(msg, color = "cyan") {
        logToArea(SyntraUI.refs?.dashboardMessagesEl, msg, color);
    }

    SyntraUI.showErr = function(prefix, err) {
        let msg = `${prefix}: ${err?.message || JSON.stringify(err)}`;
        if (err?.response) {
            const d = err.response.data;
            const detail = d?.error || d?.message || JSON.stringify(d);
            msg = `${prefix}: Status ${err.response.status}, Errore: ${detail}`;
        } else if (typeof err === 'object' && err !== null && err.message) {
            msg = `${prefix}: ${err.message}`;
        }
        // Usiamo this per riferirci a SyntraUI
        this.logDashboardMsg(msg, "red");
        this.showToast(msg, 'error', 6000);
        console.error(prefix, err?.response || err);
    }

    // --- Gestione Loading State ---
    SyntraUI.showLoading = function(message = "Operazione in corso...") {
        const overlay = SyntraUI.refs?.loadingOverlay;
        if (overlay) {
            overlay.querySelector('p').textContent = message;
            overlay.classList.remove('hidden');
        }
    }
    SyntraUI.hideLoading = function() {
        const overlay = SyntraUI.refs?.loadingOverlay;
        if (overlay) {
            overlay.classList.add('hidden');
        }
    }

    SyntraUI.setButtonLoading = function(button, isLoading) {
        if (!button) return;
        const wasInitiallyDisabled = button.hasAttribute('disabled') && !button.classList.contains('loading');
        if (isLoading) {
            button.setAttribute('data-keep-disabled', wasInitiallyDisabled ? 'true' : 'false');
            button.classList.add('loading');
            button.disabled = true;
            button.setAttribute('disabled', '');
        } else {
            button.classList.remove('loading');
            const keepDisabled = button.getAttribute('data-keep-disabled') === 'true';
            if (!keepDisabled) {
                 button.disabled = false;
                 button.removeAttribute('disabled');
            }
            button.removeAttribute('data-keep-disabled');
        }
    }

    // --- Gestione Toast ---
    function removeToast(toast) {
        const container = SyntraUI.refs?.toastContainer;
        if (!toast || !container || !toast.parentNode) return;
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => {
            if (toast.parentNode === container) {
                container.removeChild(toast);
            }
        }, { once: true });
    }

    SyntraUI.showToast = function(message, type = 'info', duration = 4000) {
        const container = SyntraUI.refs?.toastContainer;
        if (!container) { console.warn("Toast container not found"); return; }
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `<span class="toast-message">${message}</span>`;
        container.appendChild(toast);
        void toast.offsetWidth; // Force reflow
        requestAnimationFrame(() => toast.classList.add('show'));
        const timerId = setTimeout(() => { removeToast(toast); }, duration);
        toast.addEventListener('click', () => { clearTimeout(timerId); removeToast(toast); }, { once: true });
    }

}(window.SyntraUI = window.SyntraUI || {})); // Crea l'oggetto globale se non esiste