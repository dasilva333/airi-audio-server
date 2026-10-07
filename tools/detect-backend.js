#!/usr/bin/env node
/**
 * Print the auto-resolved GPU backend (cuda|vulkan|cpu) for shell/batch callers.
 * Never fails loudly: falls back to "vulkan" so installers can proceed and let
 * build-audio-cpp.js report precise missing prerequisites.
 */
const gpu = require('../src/gpu');

try {
  const info = gpu.resolveBackend({});
  process.stdout.write(info.backend || 'vulkan');
} catch (e) {
  process.stdout.write('vulkan');
}
