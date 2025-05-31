# Fase 1: Build Base e Installazione Dipendenze
FROM node:20-alpine AS base

# Argomenti di build
ARG KUBECTL_VERSION=v1.28.2
ARG GIT_REPO_URL=https://github.com/SyntraNetProtocol/SyntraSwarm.git
ARG GIT_BRANCH=main

# Variabili d'ambiente di default per l'applicazione
ENV NODE_ENV=production
ENV PORT=5501
ENV K8S_NAMESPACE="syntracloud"
ENV IPFS_API_URL="http://127.0.0.1:5001"
ENV PYTHONUNBUFFERED=1

# Directory di lavoro principale
WORKDIR /opt/app

# Installare dipendenze di sistema:
# - git: per clonare il repo
# - curl: per scaricare kubectl
# - procps: per utilità di processo (es. ps), utile per debug
# - python3: necessario per node-gyp
# - py3-pip: pip per Python, a volte utile
# - make: necessario per node-gyp
# - g++: compilatore C++, necessario per node-gyp
# - build-base: meta-pacchetto Alpine che include make, g++, ecc. (alternativa a specificare make e g++ separatamente)
RUN apk add --no-cache \
    git \
    curl \
    procps \
    python3 \
    py3-pip \
    make \
    g++
# Alternativa per build-base:
# RUN apk add --no-cache git curl procps python3 py3-pip build-base

# Installare kubectl
RUN echo "==> Installando kubectl versione ${KUBECTL_VERSION}..." \
    && curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/ \
    && echo "==> kubectl installato."

# Clonare il repository specificato NELLA DIRECTORY DI LAVORO CORRENTE (/opt/app)
RUN echo "==> Clonando repository ${GIT_REPO_URL} (branch: ${GIT_BRANCH}) in $(pwd)..." \
    && git clone --branch ${GIT_BRANCH} --single-branch --depth 1 ${GIT_REPO_URL} . \
    && echo "==> Repository clonato."

# --------------- SEZIONE DI DEBUG FILE SYSTEM (PUOI COMMENTARLA O RIMUOVERLA DOPO) ---------------
RUN echo "==> DEBUG: Contenuto di $(pwd) (dovrebbe essere la root del repo clonato):" \
    && ls -la
# --------------- FINE SEZIONE DI DEBUG FILE SYSTEM ---------------

# Verifica esplicita dell'esistenza di package.json nella WORKDIR corrente (/opt/app)
RUN echo "==> Verificando l'esistenza di package.json in $(pwd)..." \
    && if [ ! -f package.json ]; then \
         echo "ERRORE CRITICO: package.json non trovato in $(pwd) !" \
         && echo "Controllare la struttura del repository ${GIT_REPO_URL}." \
         && exit 1; \
       else \
         echo "==> package.json trovato in $(pwd)."; \
       fi

# Installa le dipendenze dell'applicazione master
RUN echo "==> Installando dipendenze Node.js da $(pwd)..." \
    && npm ci --omit=dev --no-fund --no-audit --legacy-peer-deps \
    && echo "==> Dipendenze Node.js installate."

# Esporre la porta dell'applicazione (definita da ENV PORT)
EXPOSE ${PORT}

# Comando per avviare l'applicazione master
CMD ["node", "server.js"]

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://localhost:${PORT}/health" || exit 1