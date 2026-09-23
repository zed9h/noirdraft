import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

let child;
let closing = false;
let restarting = false;
let forceQuit;
let restartTimer;
let pollTimer;
let polling = false;
let sourceState;

function isRunning() {
  return child?.exitCode === null && child.signalCode === null;
}

function startElectron() {
  console.log('Starting Electron...');
  child = spawn('electron', ['.'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // Tells the app to skip its unsaved-changes close prompt: SIGTERM below
    // must always result in a clean exit, never a dialog blocking forever
    // on a renderer response this watcher never sends.
    env: { ...process.env, NOIRDRAFT_DEV_AUTORESTART: '1' },
  });

  child.once('error', (error) => {
    console.error(`Unable to start Electron: ${error.message}`);
    closing = true;
    process.exit(1);
  });

  child.once('exit', (code) => {
    clearTimeout(forceQuit);

    if (closing) {
      process.exit(0);
      return;
    }

    if (restarting) {
      restarting = false;
      startElectron();
      return;
    }

    process.exit(code ?? 1);
  });
}

function restartElectron() {
  if (closing || restarting) return;
  restarting = true;

  if (!isRunning()) {
    restarting = false;
    startElectron();
    return;
  }

  console.log('Source changed; restarting Electron...');
  // Capture this specific process, not the module-level `child` binding:
  // by the time this timeout fires, a later restart cycle may already have
  // reassigned `child` to a new (legitimate) process, which would then take
  // the SIGKILL meant for this one — leaving *this* one to run forever.
  const dying = child;
  forceQuit = setTimeout(() => dying.kill('SIGKILL'), 5_000);
  forceQuit.unref();
  dying.kill('SIGTERM');
}

function terminate(signal) {
  if (closing) return;
  closing = true;
  clearTimeout(restartTimer);

  if (!isRunning()) {
    process.exit(0);
    return;
  }

  const dying = child;
  forceQuit = setTimeout(() => {
    dying.kill('SIGKILL');
    process.exit(1);
  }, 5_000);
  forceQuit.unref();
  dying.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => terminate(signal));
}

process.on('exit', () => {
  clearTimeout(restartTimer);
  clearInterval(pollTimer);
  if (isRunning()) child.kill('SIGTERM');
});

async function sourceFingerprint(directory = 'src') {
  const entries = await readdir(directory, { withFileTypes: true });
  const fingerprints = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFingerprint(entryPath);
    const details = await stat(entryPath);
    return `${entryPath}:${details.size}:${details.mtimeMs}`;
  }));
  return fingerprints.flat().sort().join('|');
}

async function pollSource() {
  if (polling || closing) return;
  polling = true;
  try {
    const nextState = await sourceFingerprint();
    if (sourceState !== undefined && nextState !== sourceState) restartElectron();
    sourceState = nextState;
  } catch (error) {
    console.error(`Unable to inspect src: ${error.message}`);
  } finally {
    polling = false;
  }
}

startElectron();
void pollSource();
pollTimer = setInterval(() => void pollSource(), 250);
