// services/k8sPodLifecycle.js

const { exec, spawn } = require("child_process");
const path = require("path");
const pty = require("node-pty");
const config = require("../../config"); // Assumi che il path del config sia corretto da qui

// AGGIUNTA: Variabile e funzione per l'immagine predefinita
// --- Variabile per memorizzare l'immagine predefinita ---
// Scegli qui il fallback iniziale desiderato (es. 'ubuntu:latest', 'debian:bullseye-slim', etc.)
let defaultImageName = 'debian:bullseye-slim';

/**
 * Imposta l'immagine Docker predefinita da utilizzare per i nuovi pod.
 * Questa è l'immagine usata da spawnPod se non ne viene specificata una nell'opzione 'image'.
 * @param {string} imageName - Il nome dell’immagine Docker (es. "ubuntu:latest").
 */
function setDefaultImage(imageName) {
  if (typeof imageName === 'string' && imageName.trim()) {
    console.log(`[K8sLifecycle] Aggiornamento immagine predefinita da "${defaultImageName}" a "${imageName}".`);
    defaultImageName = imageName.trim();
  } else {
    console.warn(`[K8sLifecycle] Tentativo di impostare un nome immagine non valido: "${imageName}". Mantenuta immagine precedente: "${defaultImageName}".`);
  }
}
// FINE AGGIUNTA

// Funzione di terminazione pod (se esisteva altrove, consolida qui)
async function terminatePod(podName, namespace = config.K8S_NAMESPACE) {
    console.log(`[K8sLifecycle] Richiesta terminazione pod ${podName} in namespace ${namespace}...`);
    const cmd = `kubectl delete pod ${podName} -n ${namespace} --grace-period=0 --force`; // Usa --force e grace-period 0 per terminazione immediata (potrebbe essere aggressivo)

    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) {
                console.error(`[K8sLifecycle] Errore terminazione pod ${podName}: ${stderr || err.message}`);
                // Non rigettare per pod non trovato, consideralo successo per il cleanup
                if (stderr.includes("NotFound")) {
                    console.warn(`[K8sLifecycle] Pod ${podName} non trovato, probabilmente già terminato.`);
                    return resolve();
                }
                return reject(new Error(`kubectl delete fallito: ${stderr || err.message}`));
            }
            console.log(`[K8sLifecycle] Pod ${podName} terminato: ${stdout.trim()}`);
            resolve();
        });
    });
}


/**
 * Spawns a new Kubernetes Pod based on provided specifications.
 * Generates a Pod manifest YAML and applies it using kubectl apply.
 *
 * @param {object} options - Pod configuration options.
 * @param {string} options.ram - Requested RAM (e.g., "100Mi").
 * @param {string} options.cpu - Requested CPU (e.g., "100m").
 * @param {string} options.clientId - Client ID for labeling/identification (usato nei label).
 * @param {string} options.podNameOverride - Il nome specifico da usare per il pod.
 * @param {string} [options.namespace=config.K8S_NAMESPACE] - Kubernetes namespace.
 * @param {string} [options.image] - Container image to use. **If omitted or invalid, defaultImageName will be used.**
 * @param {string|null} [options.pvcName=null] - Name of the PVC to mount at /data, or null for emptyDir.
 * @param {string} [options.mountPath='/data'] - Path inside the container where the volume should be mounted.
 * @param {object|null} [options.nodeSelector=null] - Optional node selector object { key: value }.
 * @returns {Promise<string>} Resolves with the actual pod name on success.
 * @throws {Error} If Pod YAML generation or kubectl apply fails.
 */
async function spawnPod({
  ram,
  cpu,
  clientId,
  podNameOverride,
  namespace = config.K8S_NAMESPACE, // Usa default dal config locale se non fornito
  image, // L'immagine fornita (può essere undefined)
  pvcName = null,
  mountPath = '/data',
  nodeSelector = null, // Aggiunto gestione nodeSelector
}) {
  console.log(`[K8sLifecycle] Request to spawn pod: Name=${podNameOverride}, RAM=${ram}, CPU=${cpu}, PVC=${pvcName || 'emptyDir'}.`);

  // --- Logica per decidere l'immagine da usare ---
  // Usa l'immagine fornita se è una stringa valida, altrimenti usa la defaultImageName
  const imageToUse = (typeof image === 'string' && image.trim()) ? image.trim() : defaultImageName;
  console.log(`[K8sLifecycle] Immagine per pod ${podNameOverride}: Utilizzo "${imageToUse}" (specificata in input: "${image || 'nessuna'}").`);

  // Validazione finale dell'immagine da usare (dopo aver scelto tra fornita e default)
  if (typeof imageToUse !== 'string' || !imageToUse.trim()) {
    console.error(`[K8sLifecycle] ERRORE: Immagine finale determinata ("${imageToUse}") non valida. Impossibile creare il Pod.`);
    throw new Error("Nome immagine Docker non valido specificato o configurato come default.");
  }

   // Costruisce la sezione nodeSelector YAML se presente
   const selectorYaml = nodeSelector
     ? `
  nodeSelector:
${Object.entries(nodeSelector)
        .map(([k, v]) => `    ${k}: "${v}"`) // Indentazione 4 spazi sotto nodeSelector
        .join("\n")}`
     : ""; // Stringa vuota se nessun selector


  const podManifest = `
apiVersion: v1
kind: Pod
metadata:
  name: ${podNameOverride}
  namespace: ${namespace}
  labels:
    app: syntranet-pod # O syntranet-terminal come nell'altro file? Scegliere uno standard.
    clientId: "${clientId}"
spec:
  containers:
  - name: shell-container
    image: ${imageToUse} # <-- USA L'IMMAGINE DETERMINATA QUI
    command: ["/bin/sh", "-c"]
    args: ["while true; do sleep 3600; done"] # Mantenuto il comando di sleep per mantenere il pod vivo
    resources:
      requests:
        memory: "${ram}"
        cpu: "${cpu}"
      limits: # Linea 19 (con indentazione corretta)
        memory: "${parseInt(ram, 10) * 2}Mi" # Linea 20 (con indentazione corretta)
        cpu: "${parseInt(cpu, 10) * 2}m"   # Linea 21 (con indentazione corretta)
    volumeMounts:
    - name: data-volume
      mountPath: "${mountPath}"
${selectorYaml} # Inserisce qui la sezione nodeSelector se non è vuota
  volumes: # Linea 25 (con indentazione corretta)
  - name: data-volume # Linea 26 (con indentazione corretta)
    ${pvcName ? `persistentVolumeClaim:\n      claimName: ${pvcName}` : `emptyDir: {}`} # Contenuto volume (indentazione 6 per il contenuto)
  restartPolicy: Never # Linea 28 (con indentazione corretta)
  terminationGracePeriodSeconds: 10 # Linea 29 (con indentazione corretta)
`;
  // Ho ricalcolato le linee per il caso senza nodeSelector per coerenza con l'errore originale.
  // Se selectorYaml è presente, le linee successive si spostano.

  // --- TEMPORARY DEBUG LOG (Rimosso) ---
  // console.log('[K8sLifecycle] Generated Pod Manifest YAML:');
  // console.log(podManifest); // Stampa l'intera stringa YAML
  // console.log('--- End Manifest YAML ---');
  // --- END TEMPORARY DEBUG LOG ---


  console.log(`[K8sLifecycle] Applying manifest for pod ${podNameOverride} in namespace ${namespace}...`);
  return new Promise((resolve, reject) => {
    const kubectl = spawn("kubectl", ["apply", "-n", namespace, "-f", "-"], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = "";
    let stderr = "";

    kubectl.stdout.on("data", data => stdout += data.toString());
    kubectl.stderr.on("data", data => stderr += data.toString());

    kubectl.on("close", code => {
      if (stdout.trim()) {
        console.log(`[K8sLifecycle] kubectl apply stdout for ${podNameOverride}: ${stdout.trim()}`);
      }
      if (stderr.trim()) {
        console.warn(`[K8sLifecycle] kubectl apply stderr for ${podNameOverride}: ${stderr.trim()}`);
      }

      if (code === 0) {
        console.log(`[K8sLifecycle] Pod ${podNameOverride} manifest applied successfully.`);
        resolve(podNameOverride);
      } else {
        const msg = stderr || stdout || "Unknown error";
        console.error(`[K8sLifecycle] kubectl apply failed for pod ${podNameOverride} (code ${code}): ${msg}`);
        // In caso di errore YAML, possiamo aggiungere un log del manifesto per debugging post-mortem
         if (msg.includes("YAML") || msg.includes("error parsing")) {
             console.error(`[K8sLifecycle] Errore YAML rilevato. Manifesto che ha causato l'errore:\n${podManifest}`);
         }
        reject(new Error(`kubectl apply failed: ${msg}`));
      }
    });

    kubectl.on("error", err => {
      console.error(`[K8sLifecycle] Failed to spawn kubectl apply: ${err.message}`);
      reject(new Error(`kubectl spawn error: ${err.message}`));
    });

    try {
      kubectl.stdin.write(podManifest);
      kubectl.stdin.end();
    } catch (err) {
      console.error(`[K8sLifecycle] Error writing manifest to kubectl stdin: ${err.message}`);
      reject(new Error(`Error writing to stdin: ${err.message}`));
    }
  });
}

/**
 * Waits for a pod to reach the 'Ready' condition.
 * @param {string} podName - The name of the pod to wait for.
 * @param {string} [namespace=config.K8S_NAMESPACE] - The Kubernetes namespace.
 * @param {number} [timeoutSeconds=120] - Maximum time to wait in seconds.
 * @returns {Promise<void>}
 */
async function waitForPodReady(podName, namespace = config.K8S_NAMESPACE, timeoutSeconds = 120) {
  console.log(`[K8sLifecycle] Waiting up to ${timeoutSeconds}s for pod ${podName} in namespace ${namespace}...`);
  const cmd = `kubectl wait --for=condition=Ready pod/${podName} -n ${namespace} --timeout=${timeoutSeconds}s`;

  return new Promise((resolve, reject) => {
    exec(cmd, (err, out, st) => {
      if (err) {
        console.error(`[K8sLifecycle] Pod ${podName} in ${namespace} not Ready: ${st || err.message}`);
        exec(`kubectl describe pod ${podName} -n ${namespace}`, (descErr, descOut) => {
          if (!descErr) {
            console.error(`[K8sLifecycle] Description for ${podName} in ${namespace}:\n${descOut}`);
          }
          reject(new Error(`Timeout waiting for Ready: ${st || err.message}`));
        });
      } else {
        console.log(`[K8sLifecycle] Pod ${podName} in ${namespace} is Ready.`);
        resolve();
      }
    });
  });
}

/**
 * Spawns a PTY for an existing pod.
 * @param {string} podName
 * @param {string} [namespace=config.K8S_NAMESPACE]
 * @returns {pty.IPty}
 */
function spawnPtyForPod(podName, namespace = config.K8S_NAMESPACE) {
  const shell = "/bin/sh";
  const args = ["exec", "-i", "-t", `${podName}`, "-n", namespace, "--", shell];

  console.log(`[K8sLifecycle] Spawning PTY: kubectl ${args.join(" ")}`);
  try {
    const p = pty.spawn("kubectl", args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.env.HOME,
      env: process.env
    });
    console.log(`[K8sLifecycle] PTY spawned (PID: ${p.pid})`);
    return p;
  } catch (err) {
    console.error(`[K8sLifecycle] PTY spawn failed: ${err.message}`);
    throw new Error(`PTY spawn error: ${err.message}`);
  }
}


module.exports = {
  spawnPod,
  waitForPodReady,
  spawnPtyForPod,
  setDefaultImage, // Esporta la funzione
  terminatePod, // Assicurati di esportare terminatePod se la usi (es. in performCleanup in server.js)
};