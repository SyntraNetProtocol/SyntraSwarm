// js/ui-dashboard.js
(function (SyntraUI) {
  'use strict';

  // Alias per loggare, include un timestamp per chiarezza
  const log = (message, color = '', level = 'log') => {
      const timestamp = new Date().toLocaleTimeString();
      const style = color ? `color:${color}` : '';
      // Usa console[level] per poter loggare warn/error etc.
      console[level](`%c[${timestamp}][Dashboard] ${message}`, style);
  };
  // Assicurati che la funzione esista o definiscila
  if (typeof SyntraUI.logDashboardMsg !== 'function') {
       SyntraUI.logDashboardMsg = log;
  }

  // --- DICHIARAZIONE DEL FLAG ---
  let isCheckingSubs = false;
  // -----------------------------

  // --- Handler Eventi Dashboard ---

  SyntraUI.onConfigureSubClick = function () {
      log('onConfigureSubClick triggered');
      SyntraUI.openSubscribeDialog(); // Chiama la funzione dal modulo dialogs
  };

  SyntraUI.onConfirmSubClick = async function (event) {
      log('onConfirmSubClick triggered');
      const button = event.currentTarget;
      const refs = SyntraUI.refs;
      const state = SyntraUI.state;

      // Recupera username/password ancora dal DOM - INSECURE! Da sostituire con token/sessione
      const username = refs?.usernameInput?.value.trim();
      const password = refs?.passwordInput?.value.trim();

      if (!state.loggedInUserAddress || !username || !password) {
          SyntraUI.showToast("Login non valido o sessione scaduta.", "error");
          return;
      }

      const subDetails = {
          durationSec: parseInt(refs?.subDurationInput?.value || '0'),
          replicas: parseInt(refs?.subReplicasInput?.value || '0'),
          cpu: parseInt(refs?.subCpuRange?.value || '0'),
          ram: parseInt(refs?.subRamRange?.value || '0'),
          storage: parseInt(refs?.subStorageRange?.value || '0'),
          imageName: state.selectedImageName // Usa stato globale
      };
       // Validazione input
       if (!subDetails.durationSec || subDetails.durationSec < 600 || !subDetails.replicas || subDetails.replicas < 1 || !subDetails.cpu || subDetails.cpu < 100 || !subDetails.ram || subDetails.ram < 128 || isNaN(subDetails.storage) || subDetails.storage < 0) {
          SyntraUI.showToast("Valori di configurazione non validi.", "warning");
          return;
      }

      SyntraUI.setButtonLoading(button, true);
      log("Invio richiesta sottoscrizione...", "cyan");
      SyntraUI.showLoading("Invio richiesta...");

      if (window.API) {
          // Passa le funzioni helper direttamente
          const result = await window.API.subscribePodSlotAPI(username, password, subDetails, log, SyntraUI.showErr);
          if (result?.success) {
             SyntraUI.showToast("Richiesta inviata con successo!", "success");
             SyntraUI.closeSubscribeDialog(); // Chiama dal modulo dialogs
             log("Sottoscrizione richiesta. Verifica tra poco.", "lime");
             // Trigger verifica automatica dopo timeout
             setTimeout(() => {
                 log('Timeout post-subscribe scaduto.');
                 // Controlla il flag PRIMA di fare click
                 if (refs?.checkSubsButton && !refs.checkSubsButton.disabled && !isCheckingSubs) {
                    log('--> Triggering checkSubsButton.click() programmaticamente', 'magenta');
                    refs.checkSubsButton.click(); // Simula click
                 } else if (isCheckingSubs) {
                     log('--> Skipping automatic check subs trigger: check already in progress.', 'orange', 'warn');
                 } else {
                     log('--> Skipping automatic check subs trigger: button not ready or missing.', 'orange', 'warn');
                 }
              }, 3000);
          } else if (result?.stripeRedirect && result.url) {
              log("Redirect a Stripe per pagamento...", "cyan");
              SyntraUI.closeSubscribeDialog();
              window.location.href = result.url;
          } else {
              // Errore gestito da showErr, ma mostra un toast generico
              SyntraUI.showToast("Invio sottoscrizione fallito. Controlla i messaggi.", "error");
          }
      } else {
          SyntraUI.showErr("Errore", "Modulo API non disponibile");
      }
      SyntraUI.setButtonLoading(button, false);
      SyntraUI.hideLoading();
  };

  SyntraUI.onSelectImageButtonClick = function() {
      log('onSelectImageButtonClick triggered');
      SyntraUI.openImageSelectDialog(); // Chiama la funzione dal modulo dialogs
  };

  SyntraUI.onCheckSubsClick = async function (event) {
      const eventType = event?.type || 'programmatic';
      const targetId = event?.currentTarget?.id || 'N/A';
      log(`>>> onCheckSubsClick START (Event: ${eventType}, Target: ${targetId}) <<<`, 'blue');

      // Ora il controllo usa la variabile dichiarata sopra
      if (isCheckingSubs) {
          log('<<< onCheckSubsClick EXIT: Already checking subscriptions. Ignoring call. >>>', 'orange', 'warn');
          return;
      }
      // E l'assegnazione usa la variabile dichiarata sopra
      isCheckingSubs = true;
      log('   Flag isCheckingSubs impostato a true.', 'gray');

      const button = event?.currentTarget || SyntraUI.refs?.checkSubsButton;
      const refs = SyntraUI.refs;
      const state = SyntraUI.state;

      // Controlli e reset flag in caso di uscita anticipata
      if (!button) { log('<<< onCheckSubsClick EXIT: Button element not found. >>>', 'red', 'error'); isCheckingSubs = false; return; }
      if (!state.loggedInUserAddress) { log('<<< onCheckSubsClick EXIT: Login required. >>>', 'orange', 'warn'); SyntraUI.showToast('Login richiesto.', 'warning'); isCheckingSubs = false; return; }
      const username = refs?.usernameInput?.value.trim();
      const password = refs?.passwordInput?.value.trim();
      if (!username || !password) { log('<<< onCheckSubsClick EXIT: Credenziali mancanti. >>>', 'orange', 'warn'); SyntraUI.showToast('Credenziali (placeholder) mancanti.', 'warning'); isCheckingSubs = false; return; }
      log('   Controlli preliminari superati.', 'gray');
      // --------------------------------------------------------------------------

      // Reset UI iniziale
      log('   Resetting UI elements before check...', 'gray');
      if (refs?.subscriptionSelect) { refs.subscriptionSelect.innerHTML = '<option value="">-- Verifica... --</option>'; refs.subscriptionSelect.disabled = true; }
      if (refs?.openShellButton) { refs.openShellButton.disabled = true; }
      if (refs?.launchControl) { refs.launchControl.classList.add('hidden'); }
      state.selectedSubscriptionId = null;
      log('   UI resettata.', 'gray');

      SyntraUI.setButtonLoading(button, true);
      log('   Inizio verifica sottoscrizioni (chiamata API)...', 'cyan');
      SyntraUI.showLoading('Verifica...');

      let result = null;
      try {
          if (window.API && typeof window.API.checkSubscriptionsAPI === 'function') {
              log('      Chiamata a window.API.checkSubscriptionsAPI...', 'gray');
              result = await window.API.checkSubscriptionsAPI(
                  username, password, state.loggedInUserAddress, log, SyntraUI.showErr
              );
              log('      Risposta (processata da API wrapper) ricevuta.', 'gray');
              console.log('[onCheckSubsClick API Result]:', result);
          } else {
              log('   Modulo API o funzione checkSubscriptionsAPI non disponibile!', 'red', 'error');
              SyntraUI.showErr('Errore', 'Modulo API non disponibile');
              result = { success: false, subscriptions: [], error: 'Modulo API non disponibile' };
          }

          // Gestione Risultato
          log('   Gestione risultato API...', 'gray');
          if (result?.success && Array.isArray(result.subscriptions)) {
              log(`      API success: Ricevuto array 'subscriptions' con ${result.subscriptions.length} elementi. Chiamata a populateSubscriptionDropdown...`, 'green');
              SyntraUI.populateSubscriptionDropdown(result.subscriptions);
              // Populate also active sessions list under subscriptions
              try {
                  await SyntraUI.populateActiveSessions();
              } catch (e) {
                  log(`Errore caricamento sessioni attive: ${e.message}`, 'red', 'error');
              }
          } else {
              log('      API fallita o formato risposta non valido (secondo API wrapper).', 'orange', 'warn');
              if (refs?.subscriptionSelect) { refs.subscriptionSelect.innerHTML = '<option value="">-- Errore o Nessuna --</option>'; refs.subscriptionSelect.disabled = true; log('         Dropdown impostato a "Errore o Nessuna".', 'gray'); }
              if (refs?.openShellButton) { refs.openShellButton.disabled = true; log('         OpenShellButton disabilitato.', 'gray');}
              if (refs?.launchControl) { refs.launchControl.classList.add('hidden'); log('         LaunchControl nascosto.', 'gray'); }

              if (result?.error) { log(`         Errore riportato da API wrapper: ${result.error}`, 'red'); }
              else { log('         Errore generico durante la verifica.', 'red'); SyntraUI.showToast('Errore verifica sottoscrizioni.', 'error'); }
          }

      } catch (error) {
          log('<<< ECCEZIONE CATTURATA in onCheckSubsClick! >>>', 'red', 'error');
          console.error('[onCheckSubsClick Catch Block]:', error);
          SyntraUI.showErr('Errore Critico UI', `Errore durante la verifica: ${error.message}`);
          if (refs?.subscriptionSelect) { refs.subscriptionSelect.innerHTML = '<option value="">-- Errore Critico --</option>'; refs.subscriptionSelect.disabled = true; }
          if (refs?.openShellButton) { refs.openShellButton.disabled = true; }
          if (refs?.launchControl) { refs.launchControl.classList.add('hidden'); }
      } finally {
          log('   Blocco Finally di onCheckSubsClick.', 'gray');
          SyntraUI.setButtonLoading(button, false);
          SyntraUI.hideLoading();
          // Reset del flag dichiarato sopra
          isCheckingSubs = false;
          log('   Flag isCheckingSubs resettato a false.', 'gray');
          log('<<< onCheckSubsClick END >>>', 'blue');
      }
  };

  // La funzione populateSubscriptionDropdown rimane come nell'esempio precedente (con logging)
  SyntraUI.populateSubscriptionDropdown = function (subscriptionsData) {
    log('>>> populateSubscriptionDropdown START <<<', 'purple');
    const refs = SyntraUI.refs;
    const state = SyntraUI.state;

    if (!refs?.subscriptionSelect || !refs?.openShellButton || !refs?.launchControl) {
      log('[Populate Error] Elementi UI (select, open button, launch control) mancanti!', 'red', 'error');
      log('<<< populateSubscriptionDropdown EXIT: Elementi UI mancanti >>>', 'red', 'error');
      return;
    }
    log('   Elementi UI necessari trovati.', 'gray');

    log('   Dati ricevuti:', 'gray');
    console.log('[Populate Input Data]:', subscriptionsData);

    refs.subscriptionSelect.innerHTML = '';
    log('   Dropdown subscriptionsSelect pulito.', 'gray');
    let validAndActiveSubsFound = 0;
    let firstValidSubId = null;

    if (subscriptionsData && subscriptionsData.length > 0) {
      log(`   Inizio ciclo su ${subscriptionsData.length} sottoscrizioni ricevute...`, 'gray');
      subscriptionsData.forEach((subItem, index) => {
        log(`      [Loop ${index}] Processing item:`, 'gray');
        console.log(`      [Loop ${index} Item]:`, subItem);

        let actualSubId = subItem?.sub_id || 'N/A';
        let displayText = `Sub ${actualSubId} (Processing...)`;
        let isConsideredActive = false;
        let detailsText = '';
        let statusLower = '';
        let isActiveTime = false;

        if (typeof subItem === 'object' && subItem !== null && subItem.sub_id && subItem.status) {
          try {
            actualSubId = subItem.sub_id.toString();
            const startTime = parseInt(subItem.start_time);
            const endTime = parseInt(subItem.end_time);
            const nowSeconds = Date.now() / 1000;
            statusLower = subItem.status.toLowerCase();

            if (!isNaN(startTime) && !isNaN(endTime)) {
              isActiveTime = nowSeconds >= startTime && nowSeconds < endTime;
              log(`      [Loop ${index}] Time check: Start=${startTime}, End=${endTime}, Now=${nowSeconds.toFixed(0)}, IsActiveTime=${isActiveTime}`, 'gray');
            } else {
              isActiveTime = false;
              log(`      [Loop ${index}] Time check: Invalid start/end time. IsActiveTime=false`, 'orange', 'warn');
            }

            // !! USA LO STATUS DAL CAMPO DELL'OGGETTO (che è 'active' placeholder per ora) !!
            isConsideredActive = (statusLower === 'approved' || statusLower === 'active') && isActiveTime;
            log(`      [Loop ${index}] Status check: Status=${subItem.status}(->${statusLower}), IsConsideredActive=${isConsideredActive}`, 'gray');

            const endDate = !isNaN(endTime) ? new Date(endTime * 1000) : null;
            const statusText = isConsideredActive ? 'Attiva' : statusLower === 'pending' ? 'In attesa' : isActiveTime ? `Stato: ${subItem.status}` : 'Scaduta';
            detailsText = `CPU:${subItem.cpu || 'N/A'} RAM:${subItem.ram || 'N/A'} Stor:${subItem.storage || 'N/A'}Gb`;
            displayText = `Sub ${actualSubId} (${statusText}) - Scade: ${endDate ? endDate.toLocaleDateString() + ' ' + endDate.toLocaleTimeString() : 'N/D'}`;
            log(`      [Loop ${index}] Generated display text: "${displayText}"`, 'gray');

          } catch (parseError) {
            isConsideredActive = false;
            displayText = `Sub ${actualSubId} (Errore dati)`;
            log(`      [Loop ${index}] ECCEZIONE durante il parsing!`, 'red', 'error');
            console.error(`      [Loop ${index} Error]:`, parseError, subItem);
          }
        } else {
           displayText = `Sottoscrizione ${index} (Formato errato)`;
           log(`      [Loop ${index}] Formato dati non valido.`, 'orange', 'warn');
           console.warn(`      [Loop ${index} Invalid Format]:`, subItem);
        }

        if (isConsideredActive) {
          log(`      [Loop ${index}] --> Sottoscrizione ${actualSubId} è ATTIVA. Aggiunta al dropdown.`, 'green');
          const option = document.createElement('option');
          option.value = actualSubId;
          option.textContent = displayText;
          option.title = detailsText;
          refs.subscriptionSelect.appendChild(option);
          if (validAndActiveSubsFound === 0) {
            firstValidSubId = actualSubId;
            log(`         Questa è la prima attiva trovata (ID: ${firstValidSubId}).`, 'gray');
          }
          validAndActiveSubsFound++;
        } else {
           log(`      [Loop ${index}] --> Sottoscrizione ${actualSubId} NON è attiva. Ignorata.`, 'gray');
        }
      });
      log(`   Fine ciclo. Totale sottoscrizioni attive trovate: ${validAndActiveSubsFound}`, 'gray');
    } else {
       log('   Nessun dato subscriptionData fornito o array vuoto.', 'gray');
    }

    log(`   Valutazione finale: validAndActiveSubsFound = ${validAndActiveSubsFound}`, 'gray');
    if (validAndActiveSubsFound === 0) {
      log('      Nessuna sottoscrizione attiva trovata. Configurazione UI per "Nessuna Attiva"...', 'orange');
      if (subscriptionsData && subscriptionsData.length > 0) {
        log('         (C\'erano sottoscrizioni, ma nessuna attiva/valida).', 'orange');
        SyntraUI.showToast('Nessuna sottoscrizione attiva trovata (controlla stato/scadenza).', 'warning');
        refs.subscriptionSelect.innerHTML = '<option value="">-- Nessuna Attiva --</option>';
      } else {
        log('         (Nessuna sottoscrizione trovata nell\'account).', 'orange');
        SyntraUI.showToast('Nessuna sottoscrizione trovata.', 'info');
        refs.subscriptionSelect.innerHTML = '<option value="">-- Nessuna --</option>';
      }
      refs.subscriptionSelect.disabled = true;
      refs.openShellButton.disabled = true;
      refs.launchControl.classList.add('hidden');
      log('      UI aggiornata: Dropdown disabilitato, Bottone disabilitato, LaunchControl nascosto.', 'gray');
    } else {
      log(`      Trovate ${validAndActiveSubsFound} sottoscrizioni attive. Configurazione UI per "Attive"...`, 'green');
      SyntraUI.showToast(`Trovate ${validAndActiveSubsFound} sottoscrizioni attive.`, 'success');

      refs.subscriptionSelect.disabled = false;
      refs.subscriptionSelect.title = 'Seleziona sottoscrizione attiva';
      log('         Dropdown abilitato.', 'gray');

      refs.openShellButton.disabled = false; // Abilita sempre se ci sono opzioni
      refs.openShellButton.title = 'Lancia terminale per la sottoscrizione selezionata';
      log('         OpenShellButton abilitato.', 'gray');

      refs.launchControl.classList.remove('hidden');
      log('         LaunchControl reso visibile.', 'gray');

      if (firstValidSubId) {
        refs.subscriptionSelect.value = firstValidSubId;
        state.selectedSubscriptionId = firstValidSubId;
        log(`         Pre-selezionata sottoscrizione attiva: ID ${firstValidSubId}`, 'gray');
      } else {
        log('         Nessuna sottoscrizione specifica pre-selezionata (improbabile). Disabilitazione bottone Launch.', 'orange', 'warn');
        refs.openShellButton.disabled = true;
        state.selectedSubscriptionId = null;
      }

      log('         Rimozione/Aggiunta listener "change" al dropdown.', 'gray');
      refs.subscriptionSelect.removeEventListener('change', SyntraUI.onSubscriptionChange);
      refs.subscriptionSelect.addEventListener('change', SyntraUI.onSubscriptionChange);

      log('         Chiamata manuale a onSubscriptionChange per sincronizzare stato iniziale.', 'gray');
      SyntraUI.onSubscriptionChange();
    }
    log('<<< populateSubscriptionDropdown END >>>', 'purple');
  };


  SyntraUI.onSubscriptionChange = function () {
      log('>>> onSubscriptionChange START <<<', 'teal');
      const refs = SyntraUI.refs;
      const state = SyntraUI.state;
      const selectedValue = refs?.subscriptionSelect?.value;

      state.selectedSubscriptionId = selectedValue;
      log(`   Nuovo valore selezionato: ${selectedValue || 'Nessuno'}`, 'gray');

      const isDisabled = !selectedValue;
      refs.openShellButton.disabled = isDisabled;
      refs.openShellButton.title = selectedValue
          ? `Lancia terminale per sub ${selectedValue}`
          : 'Seleziona una sottoscrizione valida';
      log(`   OpenShellButton ${isDisabled ? 'disabilitato' : 'abilitato'}. Titolo aggiornato.`, 'gray');
      log('<<< onSubscriptionChange END >>>', 'teal');
  };



  SyntraUI.onOpenShellClick = function (event) {
    const button = event.currentTarget;
    const refs = SyntraUI.refs;
    const state = SyntraUI.state;

    if (!state.loggedInUserAddress) {
      SyntraUI.showToast('Login richiesto.', 'error');
      SyntraUI.writeToTerminal(
        '\r\n\x1b[31mERRORE: Login richiesto.\x1b[0m'
      );
      return;
    }
    if (!state.selectedSubscriptionId) {
      SyntraUI.showToast('Seleziona una sottoscrizione.', 'error');
      SyntraUI.writeToTerminal(
        '\r\n\x1b[31mERRORE: Seleziona sottoscrizione.\x1b[0m'
      );
      return;
    }

    const username = refs?.usernameInput?.value.trim();
    const password = refs?.passwordInput?.value.trim();
    if (!username || !password) {
      SyntraUI.showToast('Credenziali (placeholder) mancanti.', 'error');
      SyntraUI.writeToTerminal(
        '\r\n\x1b[31mERRORE: Credenziali mancanti.\x1b[0m'
      );
      return;
    }

    SyntraUI.setButtonLoading(button, true);
    log(`Avvio shell per sub ${state.selectedSubscriptionId}...`, 'cyan');
 
    SyntraUI.disposeTermListeners();
    SyntraUI.clearTerminal();

    SyntraUI.setActiveView('terminal');

    SyntraUI.writeToTerminal(
      `\x1b[1;33m[Shell] Richiesta connessione per sub ID ${state.selectedSubscriptionId}...\x1b[0m\r\n`
    );

    if (window.WebSocketManager) {
      window.WebSocketManager.connectWebSocket(
        state.loggedInUserAddress,
        state.selectedSubscriptionId,
        username,
        password
      );
    } else {
      SyntraUI.showErr('Errore', 'WebSocketManager non disponibile');
      SyntraUI.setButtonLoading(button, false);
      SyntraUI.hideLoading();
      SyntraUI.setActiveView('dashboard');
    }
    button.disabled = true;
  };

  SyntraUI.onCloseTerminalClick = function () {
    const refs = SyntraUI.refs;

    SyntraUI.setActiveView('dashboard');
    SyntraUI.clearTerminal();

    if (window.WebSocketManager) {
      window.WebSocketManager.disconnectWebSocket(
        'User closed terminal manually'
      );
    }
    SyntraUI.disposeTermListeners();

    if (refs?.openShellButton) {
      SyntraUI.setButtonLoading(refs.openShellButton, false);
      refs.openShellButton.disabled = !refs.subscriptionSelect?.value;
    }
    if (
      refs?.launchControl &&
      refs?.subscriptionSelect &&
      refs.subscriptionSelect.options.length > 0 &&
      refs.subscriptionSelect.value
    ) {
      refs.launchControl.classList.remove('hidden');
    } else if (refs?.launchControl) {
      refs.launchControl.classList.add('hidden');
    }

    log(
      'Terminale chiuso. Seleziona una sottoscrizione per riconnetterti.',
      'cyan'
    );
  SyntraUI.showToast('Terminale chiuso.', 'info', 3000);
  };

  /**
   * Recupera e mostra le sessioni attive per l'utente, con pulsanti per terminarle.
   */
  SyntraUI.populateActiveSessions = async function() {
    const refs = SyntraUI.refs;
    const state = SyntraUI.state;
    // Contenitore delle sessioni attive
    const launchCard = refs?.launchControl?.parentNode;
    if (!launchCard) return;
    let listEl = document.getElementById('activeSessionsList');
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.id = 'activeSessionsList';
      listEl.className = 'active-sessions-list';
      launchCard.appendChild(listEl);
    }
    listEl.innerHTML = '';
    try {
      const userAddr = state.loggedInUserAddress;
      // Call API server on port 5501 (Express) to list sessions
      const apiPort = 5501;
      const apiUrl = `${window.location.protocol}//${window.location.hostname}:${apiPort}/api/sessions?userAddress=${encodeURIComponent(userAddr)}`;
      const resp = await fetch(apiUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Fetch error');
      const sessions = data.sessions || [];
      if (sessions.length === 0) {
        listEl.innerHTML = '<p class="no-sessions">Nessuna sessione attiva.</p>';
        return;
      }
      sessions.forEach(s => {
        const row = document.createElement('div');
        row.className = 'session-item';
        const label = document.createElement('span');
        label.textContent = `${s.podName} [${s.status}]`;
        // Stop button
        const stopBtn = document.createElement('button');
        stopBtn.className = 'button button-small session-stop-btn';
        stopBtn.textContent = '✖';
        stopBtn.title = 'Termina sessione';
        stopBtn.addEventListener('click', async () => {
          try {
            const apiPort = 5501;
            const terminateUrl = `${window.location.protocol}//${window.location.hostname}:${apiPort}/api/sessions/${encodeURIComponent(s.id)}/terminate`;
            await fetch(terminateUrl, { method: 'POST' });
            await SyntraUI.populateActiveSessions();
          } catch (e) {
            log(`Errore terminazione sessione ${s.id}: ${e.message}`, 'red', 'error');
          }
        });
        // Play (reattach) button
        const playBtn = document.createElement('button');
        playBtn.className = 'button button-small session-play-btn';
        playBtn.textContent = '▶';
        playBtn.title = 'Ricollega sessione';
        playBtn.addEventListener('click', () => {
          // Reattach terminal session
          log(`Reattaching to session ${s.id}`, 'green');
          const state = SyntraUI.state;
          const refs = SyntraUI.refs;
          // Ensure user is logged in
          if (!state.loggedInUserAddress) {
            SyntraUI.showToast('Login richiesto per reattach.', 'error');
            return;
          }
          // Get credentials from inputs
          const username = refs?.usernameInput?.value.trim();
          const password = refs?.passwordInput?.value.trim();
          if (!username || !password) {
            SyntraUI.showToast('Credenziali mancanti per reattach.', 'error');
            return;
          }
          // Prepare terminal UI
          SyntraUI.disposeTermListeners();
          SyntraUI.clearTerminal();
          SyntraUI.setActiveView('terminal');
          SyntraUI.writeToTerminal(`\x1b[1;33m[Shell] Reattach session ${s.id}...\x1b[0m\r\n`);
          // Connect via WebSocketManager using session ID as identifier for reattach
          if (window.WebSocketManager) {
            window.WebSocketManager.connectWebSocket(
              state.loggedInUserAddress,
              s.id,
              username,
              password
            );
          } else {
            SyntraUI.showErr('Errore', 'WebSocketManager non disponibile');
          }
          // Disable the play button to prevent duplicate clicks
          playBtn.disabled = true;
        });
        row.appendChild(label);
        row.appendChild(playBtn);
        row.appendChild(stopBtn);
        listEl.appendChild(row);
      });
    } catch (e) {
      log(`Errore caricamento sessioni attive: ${e.message}`, 'red', 'error');
      listEl.innerHTML = '<p class="error-sessions">Errore caricamento sessioni.</p>';
    }
  };

})(window.SyntraUI = window.SyntraUI || {});