/**
 * AIRI Audio Server Lifecycle Controller (audio_ctl.js)
 * Inspired by E:\CUIPP\comfy_ctl.py
 *
 * Provides status, start, stop, and restart with:
 * - WMI/CIM process breakaway (persists across SSH/terminal closure)
 * - PID tracking & port inspection (:8095)
 * - Health check polling (/health)
 * - Headless and Interactive desktop launch modes
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname);
const PID_FILE = path.join(SERVER_DIR, '.airi_audio.pid');
const LOG_FILE = path.join(SERVER_DIR, 'server.log');
const PORT = 8095;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

function getListeningPid(port = PORT) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
    const lines = out.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING') {
        const pid = parseInt(parts[4], 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
  } catch (e) {
    // not listening
  }
  return null;
}

async function queryHealth(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    // offline
  }
  return null;
}

async function getStatus() {
  const pid = getListeningPid();
  const health = await queryHealth();

  if (pid || health) {
    console.log('=======================================================');
    console.log('Status: RUNNING');
    if (pid) console.log(`PID   : ${pid}`);
    console.log(`URL   : http://127.0.0.1:${PORT}`);
    if (health) {
      console.log(`Engine Ready: ${health.engine_ready}`);
      console.log(`Active Model: ${health.active_model}`);
    } else {
      console.log('API: Port bound, initializing engine...');
    }
    console.log('=======================================================');
    return true;
  } else {
    console.log('=======================================================');
    console.log('Status: STOPPED');
    console.log(`AIRI Audio Server is not currently running on port ${PORT}.`);
    console.log('=======================================================');
    return false;
  }
}

async function startServer(headless = true, timeoutSec = 30) {
  const existingPid = getListeningPid();
  if (existingPid) {
    console.log(`[INFO] AIRI Audio Server is ALREADY RUNNING (PID: ${existingPid}) on port ${PORT}.`);
    await getStatus();
    return true;
  }

  console.log(`[INFO] Launching AIRI Audio Server (Mode: ${headless ? 'Headless Background' : 'Interactive Window'})...`);

  // Use PowerShell WMI / CIM to break away from current process Job Object
  // This ensures the process keeps running after SSH or agent session ends.
  let psCommand = '';
  if (headless) {
    psCommand = `
      $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
          CommandLine = "cmd.exe /c node src\\server.js *>> \`"${LOG_FILE}\`""
          CurrentDirectory = "${SERVER_DIR.replace(/\\/g, '\\\\')}"
      }
      $res.ProcessId
    `;
  } else {
    psCommand = `
      $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
          CommandLine = "cmd.exe /c start \`"AIRI Audio Server\`" cmd.exe /k \`"node src\\server.js\`""
          CurrentDirectory = "${SERVER_DIR.replace(/\\/g, '\\\\')}"
      }
      $res.ProcessId
    `;
  }

  const spawnRes = spawnSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { encoding: 'utf-8' });
  const spawnedPid = spawnRes.stdout.trim();
  console.log(`[INFO] WMI Process Created (Launcher PID: ${spawnedPid}). Polling health on ${HEALTH_URL}...`);

  const t0 = Date.now();
  let ready = false;
  let healthInfo = null;

  while ((Date.now() - t0) / 1000 < timeoutSec) {
    healthInfo = await queryHealth(1000);
    if (healthInfo && healthInfo.status === 'ok') {
      ready = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1500));
    process.stdout.write('.');
  }
  console.log('');

  if (ready) {
    const activePid = getListeningPid() || spawnedPid;
    fs.writeFileSync(PID_FILE, String(activePid), 'utf-8');
    console.log('\n=======================================================');
    console.log('[SUCCESS] AIRI Audio Server is UP AND READY!');
    console.log(`URL         : http://127.0.0.1:${PORT}`);
    console.log(`PID         : ${activePid}`);
    console.log(`Active Model: ${healthInfo.active_model}`);
    console.log(`Engine Ready: ${healthInfo.engine_ready}`);
    console.log('=======================================================\n');
    return true;
  } else {
    console.error(`\n[WARNING] Timed out waiting ${timeoutSec}s for AIRI Audio Server on ${HEALTH_URL}.`);
    console.error(`Check ${LOG_FILE} for details.`);
    return false;
  }
}

async function stopServer() {
  console.log('[INFO] Stopping AIRI Audio Server...');
  let targetPid = null;

  if (fs.existsSync(PID_FILE)) {
    try {
      targetPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    } catch (e) {}
  }

  const listeningPid = getListeningPid();
  const pidToKill = listeningPid || targetPid;

  if (pidToKill) {
    console.log(`[INFO] Killing process tree for PID ${pidToKill}...`);
    try {
      execSync(`taskkill /F /T /PID ${pidToKill}`, { stdio: 'ignore' });
    } catch (e) {}
  }

  // Also clean up any lingering audiocpp_server.exe subprocesses
  try {
    execSync('taskkill /F /IM audiocpp_server.exe', { stdio: 'ignore' });
  } catch (e) {}

  if (fs.existsSync(PID_FILE)) {
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
  }

  // Verify port release
  await new Promise(r => setTimeout(r, 1000));
  const stillListening = getListeningPid();
  if (!stillListening) {
    console.log('[SUCCESS] AIRI Audio Server stopped and port released.');
    return true;
  } else {
    console.warn(`[WARNING] Port ${PORT} still in use by PID ${stillListening}. Forcing kill...`);
    try { execSync(`taskkill /F /PID ${stillListening}`, { stdio: 'ignore' }); } catch (e) {}
    return true;
  }
}

async function restartServer(headless = true) {
  console.log('[INFO] Restarting AIRI Audio Server...');
  await stopServer();
  await new Promise(r => setTimeout(r, 2000));
  return await startServer(headless);
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const isHeadless = !process.argv.includes('--window');

  switch (cmd.toLowerCase()) {
    case 'status':
      await getStatus();
      break;
    case 'start':
      await startServer(isHeadless);
      break;
    case 'stop':
      await stopServer();
      break;
    case 'restart':
      await restartServer(isHeadless);
      break;
    default:
      console.log(`Usage: node audio_ctl.js [status|start|stop|restart] [--window]`);
      break;
  }
}

main().catch(err => {
  console.error('[Error]', err);
  process.exit(1);
});
