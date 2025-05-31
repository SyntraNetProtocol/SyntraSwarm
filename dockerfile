# Scegli un'immagine base. node:20-alpine è buona per Node.js e leggera.
FROM node:20-alpine AS base

# ARG per flessibilità
ARG KUBECTL_VERSION=v1.28.2 # Scegli la versione di kubectl che ti serve
ARG GIT_REPO_URL=https://github.com/SyntraNetProtocol/SyntraSwarm.git
ARG GIT_BRANCH=main # O un branch/tag specifico
ARG APP_SUB_DIR=backend/master

# Variabili d'ambiente di default per l'applicazione
ENV NODE_ENV=production
ENV PORT=5501
ENV K8S_NAMESPACE="syntracloud"
ENV IPFS_API_URL="http://127.0.0.1:5001"

# Directory di lavoro principale per il clone
WORKDIR /opt/syntraswarm

# Installare dipendenze di sistema: git (per clonare) e curl (per scaricare kubectl)
RUN apk add --no-cache git curl

# Installare kubectl
RUN curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

# Clonare il repository
RUN git clone --branch ${GIT_BRANCH} --single-branch --depth 1 ${GIT_REPO_URL} .

# Impostare la directory di lavoro per l'applicazione master
WORKDIR /opt/syntraswarm/${APP_SUB_DIR}

# Controlla se package.json esiste prima di eseguire npm ci
RUN if [ ! -f package.json ]; then \
      echo "Errore: package.json non trovato in $(pwd)" && exit 1; \
    fi

# Installa le dipendenze dell'applicazione master
RUN npm ci --omit=dev

# Esporre la porta dell'applicazione (definita da ENV PORT)
EXPOSE ${PORT}

# Comando per avviare l'applicazione
CMD ["node", "server.js"]

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://localhost:${PORT}/health" || exit 1