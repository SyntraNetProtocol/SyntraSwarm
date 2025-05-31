# Usa un'immagine Node.js ufficiale come base. Alpine è leggera.
# Scegli una versione LTS specifica, es: node:18-alpine o node:20-alpine
FROM node:20-alpine AS base

# Imposta la directory di lavoro nell'immagine
WORKDIR /usr/src/app

# Copia package.json e package-lock.json (se esiste)
# Copiare questi file separatamente permette a Docker di sfruttare la cache
# se non cambiano, evitando di rieseguire npm install inutilmente.
COPY package.json package-lock.json* ./

# Installa le dipendenze di produzione
# 'npm ci' è generalmente raccomandato per build riproducibili se hai package-lock.json
# '--only=production' assicura che le devDependencies non vengano installate
RUN npm install

# Copia il resto del codice dell'applicazione
COPY . .

# La tua applicazione sembra esporre la porta definita in .env o default (5501 da config/index.js)
# Esponiamo questa porta. Puoi cambiarla se necessario.
ENV PORT=5501
EXPOSE ${PORT}

# Definisci variabili d'ambiente di default.
# Queste possono essere sovrascritte al runtime.
# !!! ATTENZIONE: NON INCLUDERE VALORI SENSIBILI QUI (es. MASTER_ENCRYPTION_KEY) !!!
# Verranno passati tramite docker-compose.yml o comandi `docker run -e`.
ENV NODE_ENV=production
ENV K8S_NAMESPACE="syntracloud"
ENV IPFS_API_URL="http://127.0.0.1:5001"
# Aggiungi altre variabili d'ambiente da .env come default se necessario,
# ma ricorda che le più importanti (come chiavi e URL specifici) verranno passate al runtime.
# Es: ENV BASE_URL="http://localhost:8092" # O un valore più generico

# Comando per avviare l'applicazione
# Il tuo package.json usa "node server.cjs", ma il file si chiama "server.js".
# Assumendo che server.js sia corretto:
CMD ["node", "server.js"]

# Aggiungi un healthcheck se il tuo server.js ha un endpoint di health
# Sembra che tu abbia un endpoint /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://localhost:${PORT}/health" || exit 1