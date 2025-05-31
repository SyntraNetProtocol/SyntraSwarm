// k8sUtils.js - Index for Kubernetes utility modules

const lifecycle = require('./podLifecycle');
const backupRestore = require('./backupRestore');

// Combine and re-export all functions from both modules
module.exports = {
  ...lifecycle,
  ...backupRestore,
};

// Now other modules can continue to require('k8sUtils')
// e.g., require('./k8sUtils').spawnPod or require('./k8sUtils').backupPod