/**
 * Electron shell for the sonar console — makes the whole app (backend + dashboard)
 * a single double-click desktop app on Windows, macOS, and Linux, so nobody needs
 * Node.js installed or a terminal to run it.
 *
 * How it works: Electron ships its own Node.js runtime. We fork the existing
 * backend (backend/dist/index.js — unmodified, the same server `npm start` runs)
 * as a child process using Electron's own executable in "run as plain Node" mode
 * (ELECTRON_RUN_AS_NODE=1), on a free local port, then open a window pointed at
 * it. Same code path as the CLI server; this file only adds the desktop chrome.
 */
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const http = require('node:http');

let backend = null;
let win = null;
let backendPort = null;
let quitting = false;

/** Finds a free TCP port by letting the OS assign one (bind :0, read it back, release it). */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Polls the backend's health endpoint until it responds or we give up. */
function waitForBackend(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('backend did not start in time'));
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

/** Path to backend/dist/index.js, identical relative layout in dev and packaged builds (see build.files in package.json). */
function backendEntryPath() {
  return path.join(__dirname, '..', 'backend', 'dist', 'index.js');
}

function startBackend(port) {
  const child = fork(backendEntryPath(), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  child.on('exit', (code) => {
    if (!quitting && code !== 0) {
      dialog.showErrorBox('Sonar console', `The backend process exited unexpectedly (code ${code}). Check the terminal/log for details.`);
    }
  });
  return child;
}

const LOADING_HTML = `data:text/html,${encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><title>Starting…</title>
<style>
  html,body{height:100%;margin:0;background:#EEF2F5;color:#526675;
    font-family:-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center}
  .box{text-align:center}
  .dot{width:8px;height:8px;border-radius:50%;background:#0B8A80;display:inline-block;margin:0 3px;
    animation:pulse 1s ease-in-out infinite}
  .dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}
  @keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
  p{margin-top:14px;font-size:13px}
</style></head><body><div class="box">
  <div class="dot"></div><div class="dot"></div><div class="dot"></div>
  <p>Starting the sonar telemetry hub…</p>
</div></body></html>`)}`;

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#EEF2F5',
    title: 'Adaptive Sonar TX — Module Console',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  win.once('ready-to-show', () => win.show());
  // Anything the dashboard tries to open in a new tab/window opens in the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(LOADING_HTML);

  try {
    backendPort = await getFreePort();
    backend = startBackend(backendPort);
    await waitForBackend(backendPort);
    if (!win.isDestroyed()) await win.loadURL(`http://127.0.0.1:${backendPort}/`);
  } catch (err) {
    dialog.showErrorBox('Sonar console failed to start', String(err?.stack ?? err));
    app.quit();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  quitting = true;
  if (backend && !backend.killed) backend.kill();
});
