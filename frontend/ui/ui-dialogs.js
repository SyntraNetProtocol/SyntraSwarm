// js/ui-dialogs.js
// Gestione dei dialog modali (Subscribe, Image Select)

(function(SyntraUI) {
  'use strict';

  // Assicuriamoci che ci sia uno state globale
  SyntraUI.state = SyntraUI.state || {};
  SyntraUI.state.selectedImageName = SyntraUI.state.selectedImageName || 'ubuntu:latest';

  // Lista dinamica di immagini disponibili
  const AVAILABLE_IMAGES = [
    { name: 'ubuntu:latest', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/ubuntu/ubuntu-plain.svg', description: 'OS Linux base.', category: 'OS' },
    { name: 'debian:latest', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/debian/debian-plain.svg', description: 'OS Linux stabile.', category: 'OS' },
    { name: 'nginx:stable', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/nginx/nginx-original.svg', description: 'Web server leggero e veloce.', category: 'Web Server' },
    { name: 'node:lts-alpine', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/nodejs/nodejs-original.svg', description: 'Runtime Node.js leggero.', category: 'Development' },
    { name: 'python:3.11-slim', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/python/python-original.svg', description: 'Interpreter Python ufficiale.', category: 'Development' },
    { name: 'postgres:15', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/postgresql/postgresql-original.svg', description: 'Database relazionale.', category: 'Database' },
    { name: 'mysql:8', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/mysql/mysql-original.svg', description: 'Database relazionale popolare.', category: 'Database' },
    { name: 'redis:7', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/redis/redis-original.svg', description: 'In-memory key-value store.', category: 'Cache' },
    { name: 'docker:latest', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/docker/docker-original.svg', description: 'Motore container ufficiale.', category: 'Container' },
    { name: 'golang:1.20', logo: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/go/go-original.svg', description: 'Runtime Go ufficiale.', category: 'Development' }
  ];

  // --- Gestione Dialog Sottoscrizione ---
  SyntraUI.openSubscribeDialog = function() {
    const refs = SyntraUI.refs;
    if (!SyntraUI.state.loggedInUserAddress) {
      SyntraUI.showToast("Login richiesto per configurare.", "warning");
      return;
    }
    if (!refs?.subscribeDialog) {
      console.error("#subscribe-dialog non trovato!");
      return;
    }
    // Reset valori
    if (refs.subCpuRange && refs.subCpuOutput) { refs.subCpuRange.value = '200'; refs.subCpuOutput.value = refs.subCpuRange.value; }
    if (refs.subRamRange && refs.subRamOutput) { refs.subRamRange.value = '256'; refs.subRamOutput.value = refs.subRamRange.value; }
    if (refs.subStorageRange && refs.subStorageOutput) { refs.subStorageRange.value = '1'; refs.subStorageOutput.value = refs.subStorageRange.value; }
    if (refs.subDurationInput) refs.subDurationInput.value = '3600';
    if (refs.subReplicasInput) refs.subReplicasInput.value = '1';
    // Aggiorna l'immagine selezionata nel dialog di sottoscrizione
    if (refs.selectedImageNameEl) {
      refs.selectedImageNameEl.textContent = SyntraUI.state.selectedImageName;
    }
    SyntraUI.setButtonLoading(refs.confirmSubButton, false);
    if (refs.confirmSubButton) refs.confirmSubButton.disabled = false;
    try {
      refs.subscribeDialog.showModal();
    } catch (e) {
      console.error("Errore apertura dialog subscribe:", e);
      SyntraUI.showToast("Impossibile aprire il dialog di configurazione.", "error");
    }
  };

  SyntraUI.closeSubscribeDialog = function() {
    SyntraUI.refs?.subscribeDialog?.close();
  };

  // Handler per aggiornare l'output dello slider
  SyntraUI.handleSliderUpdate = function(event) {
    const slider = event.target;
    const output = slider.closest('.slider-group')?.querySelector(`output[for="${slider.id}"]`);
    if (output) {
      output.value = slider.value;
    }
  };

  // --- Gestione Dialog Selezione Immagine ---
  SyntraUI.openImageSelectDialog = function() {
    const refs = SyntraUI.refs;
    const dialog = refs?.imageSelectDialog;
    const grid = refs?.imageGrid;
    if (!dialog || !grid) {
      console.error("#image-select-dialog o .image-grid non trovato!");
      return;
    }
    grid.innerHTML = ''; // Pulisci la griglia
    // Popola dinamicamente le card
    AVAILABLE_IMAGES.forEach(img => {
      const card = document.createElement('div');
      card.className = 'image-card';
      card.dataset.imageName = img.name;
      // Aggiungi classe 'selected' se è l'immagine attualmente selezionata nello stato
      if (img.name === SyntraUI.state.selectedImageName) {
          card.classList.add('selected');
      }
      card.innerHTML = `
        <img src="${img.logo}" alt="${img.name}" class="image-logo" onerror="this.style.display='none'">
        <div class="image-details">
          <h4 class="image-title">${img.name}</h4>
          <p class="image-description">${img.description}</p>
          <span class="image-category">${img.category}</span>
        </div>
        <button type="button" class="button button-small select-image-btn">
            ${img.name === SyntraUI.state.selectedImageName ? 'Selezionata' : 'Seleziona'}
        </button>
      `;
      grid.appendChild(card);
    });
    try {
      dialog.showModal();
    } catch(e) {
      console.error("Errore apertura dialog selezione immagine:", e);
      SyntraUI.showToast("Impossibile aprire il dialog di selezione immagine.", "error");
    }
  };

  SyntraUI.closeImageSelectDialog = function() {
    SyntraUI.refs?.imageSelectDialog?.close();
  };

  // Handler per la selezione di un'immagine dalla griglia
  SyntraUI.handleImageCardSelect = async function(event) { 
    console.log('[DEBUG UI Dialogs] handleImageCardSelect avviata.');
    const button = event.target.closest('.select-image-btn');
    if (!button) return;

    const card = button.closest('.image-card');
    if (!card) return;

    const imageName = card.dataset.imageName;
    console.log('[UI] Image name letto da dataset:', imageName);
    const imageNameEl = SyntraUI.refs?.selectedImageNameEl; // Elemento nel dashboard

    if (imageName && imageNameEl) {
      console.log('[UI] Chiamata API setPodImageAPI con:', imageName);
      // Aggiorna stato UI locale
      SyntraUI.state.selectedImageName = imageName;
      imageNameEl.textContent = imageName; // Aggiorna testo nel dashboard
      SyntraUI.showToast(`Immagine ${imageName} selezionata. Invio al server...`, 'info', 2000);

      // --- CHIAMA LA NUOVA FUNZIONE API ---
      if (window.API && typeof window.API.setPodImageAPI === 'function') {
        try {
          // Mostra un loading specifico o disabilita il bottone se necessario
          SyntraUI.showLoading("Aggiornamento immagine server...");
          const result = await window.API.setPodImageAPI(imageName, SyntraUI.logDashboardMsg, SyntraUI.showErr);
          SyntraUI.hideLoading();
          if (result.success) {
            SyntraUI.showToast(`Immagine ${imageName} impostata sul server!`, 'success', 3000);
          } else {
            // L'errore è già stato mostrato da showErr passato all'API
            SyntraUI.showToast(`Errore impostazione immagine sul server.`, 'error');
          }
        } catch (apiError) {
            // Catch per sicurezza, ma errorFn dovrebbe gestire
            SyntraUI.hideLoading();
            console.error("Errore imprevisto chiamata setPodImageAPI:", apiError);
            SyntraUI.showToast("Errore imprevisto durante l'aggiornamento dell'immagine.", 'error');
        }
      } else {
        console.error("Funzione window.API.setPodImageAPI non trovata!");
        SyntraUI.showToast("Errore: Funzione API per impostare immagine mancante.", 'error');
      }
      // --- FINE CHIAMATA API ---

    } else {
        if (!imageName) console.warn("Nome immagine non trovato nel dataset della card.");
        if (!imageNameEl) console.warn("Elemento #selected-image-name non trovato nel DOM.");
    }

    SyntraUI.closeImageSelectDialog(); // Chiudi il dialog dopo la selezione e la chiamata API
  };

}(window.SyntraUI = window.SyntraUI || {}));