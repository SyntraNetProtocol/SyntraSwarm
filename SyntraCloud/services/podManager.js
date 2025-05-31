// services/podManager.js

const { exec: execPodManager } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const os = require("os");
// Rimuovi require('../config') se usi il context, altrimenti lascialo
// const config = require("../config");
// Usa il context se server.js lo inizializza con esso
// const { context } = require('../context');

// --- Variabile per memorizzare l'immagine predefinita ---
let defaultImageName = 'docker:latest'; // Immagine fallback iniziale

/**
 * Imposta l'immagine Docker predefinita da utilizzare per i nuovi pod.
 * @param {string} imageName - Il nome dell'immagine Docker (es. "ubuntu:latest").
 */
function setDefaultImage(imageName) {
  if (typeof imageName === 'string' && imageName.trim()) {
    console.log(`[podManager] Aggiornamento immagine predefinita da "${defaultImageName}" a "${imageName}"`);
    defaultImageName = imageName.trim();
  } else {
    console.warn(`[podManager] Tentativo di impostare un nome immagine non valido: "${imageName}". Mantenuta immagine precedente: "${defaultImageName}"`);
  }
}

/**
 * Crea o aggiorna un Pod in Kubernetes, montando un PVC o un emptyDir,
 * e usando l’immagine Docker specificata dall’utente o quella predefinita.
 *
 * @param {object} options
 * @param {string} options.ram       — Richiesta di RAM (es. "256Mi")
 * @param {string} options.cpu       — Richiesta di CPU (es. "100m")
 * @param {string} [options.image]   — Nome dell’immagine Docker (es. "nginx:stable"). Se omesso, usa quella predefinita.
 * @param {string} [options.clientId]
 * @param {object|null} [options.nodeSelector]
 * @param {string|null} [options.podNameOverride]
 * @param {string} [options.namespace] // Usa context.config.K8S_NAMESPACE se disponibile
 * @param {string|null} [options.pvcName]
 * @param {string} [options.mountPath="/data"]
 * @returns {Promise<string>} Il nome del Pod creato/applicato.
 * @throws {Error} In caso di errori di scrittura/applicazione del manifesto.
 */
async function spawnPod({
  ram,
  cpu,
  image, // Ora è opzionale
  clientId,
  nodeSelector = null,
  podNameOverride = null,
  namespace, // Determina il namespace sotto
  pvcName = null,
  mountPath = "/data"
}) {
  // Determina il namespace da usare (priorità: opzione, contesto, fallback)
  const k8sNamespace = namespace //|| context?.config?.K8S_NAMESPACE || "syntracloud";

  // --- Usa l'immagine fornita o quella predefinita ---
  const imageToUse = (typeof image === 'string' && image.trim()) ? image.trim() : defaultImageName;

  // Validazione finale dell'immagine da usare
  if (typeof imageToUse !== "string" || !imageToUse.trim()) {
    console.error(`[podManager] ERRORE: Immagine finale non valida "${imageToUse}". Impossibile creare il Pod.`);
    throw new Error("Nome immagine Docker non valido specificato o configurato.");
  }

  // Genera nome pod
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const podName = podNameOverride ||
    `term-${(clientId || "anon").toLowerCase().replace(/[^a-z0-9-]/g, "")}-${randomSuffix}`;

  console.log(`[podManager] Creazione/aggiornamento pod ${podName} (ns=${k8sNamespace}, image=${imageToUse})`);

  // Definizione YAML
  const volumeYaml = pvcName
    ? `
  - name: data-storage
    persistentVolumeClaim:
      claimName: ${pvcName}`
    : `
  - name: data-storage
    emptyDir: {}`;

  const selectorYaml = nodeSelector
    ? `nodeSelector:
      ${Object.entries(nodeSelector)
        .map(([k, v]) => `${k}: "${v}"`)
        .join("\n      ")}`
    : "";

  const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${k8sNamespace}
  labels:
    app: syntranet-terminal
    client: "${clientId || "unknown"}"
spec:
  containers:
  - name: terminal-container
    image: ${imageToUse} # Usa l'immagine determinata
    command: ["/bin/sh", "-c", "sleep infinity"]
    resources:
      requests:
        memory: "${ram}"
        cpu: "${cpu}"
      limits: # Considera se i limiti debbano essere diversi dalle richieste
        memory: "${ram}"
        cpu: "${cpu}"
    volumeMounts:
    - name: data-storage
      mountPath: "${mountPath}"
  ${selectorYaml}
  volumes:${volumeYaml}
  restartPolicy: Never
  terminationGracePeriodSeconds: 10
`;

  // Percorso file temporaneo
  const tmpDir = typeof os.tmpdir === "function"
    ? os.tmpdir()
    : path.resolve(__dirname, "..", "tmp"); // Assicurati che il percorso sia corretto
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `pod-${podName}-${Date.now()}.yaml`);

  console.log(`[podManager] Scrivo manifesto in ${tmpPath}`);
  await fs.writeFile(tmpPath, podYaml);

  // Applico con kubectl
  const cmd = `kubectl apply -n ${k8sNamespace} -f "${tmpPath}"`;
  console.log(`[podManager] Eseguo: ${cmd}`);

  return new Promise((resolve, reject) => {
    execPodManager(cmd, async (err, stdout, stderr) => {
      // Pulisci file temporaneo
      try { await fs.unlink(tmpPath); } catch (_) {}

      if (err) {
        console.error(`[podManager] Errore kubectl apply per ${podName}: ${stderr || err.message}`);
        return reject(new Error(`kubectl apply fallito: ${stderr || err.message}`));
      }

      console.log(`[podManager] kubectl apply output per ${podName}: ${stdout.trim()}`);
      if (stderr.trim()) {
        console.warn(`[podManager] kubectl apply warning per ${podName}: ${stderr.trim()}`);
      }
      resolve(podName);
    });
  });
}

module.exports = {
  spawnPod,
  setDefaultImage // Esporta la nuova funzione
};
