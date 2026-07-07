// =============================================================================
// mod-term — Electron MAIN process
// -----------------------------------------------------------------------------
// The main process owns everything the renderer (Chromium) cannot do safely:
//   1. Spawning real Windows shells (PowerShell / cmd) via node-pty (ConPTY).
//   2. Reading/writing workspace files on disk.
// It talks to the renderer over a small, explicit IPC surface (see preload.js).
//
// Why the pty lives here and not in the renderer:
//   node-pty is a native Node addon. It must run in a Node context, which in
//   Electron is the main process. The renderer is a sandboxed browser page and
//   deliberately has no Node access, so bytes flow: shell <-> pty (main) <-> IPC
//   <-> xterm.js (renderer).
// =============================================================================

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// node-pty is a native module. If it hasn't been rebuilt for this Electron
// version yet, we fail loudly with a helpful message instead of a cryptic crash.
let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.error(
    '\n[mod-term] Failed to load node-pty. This almost always means the native ' +
    'binary was not built for your Electron version.\n' +
    'Fix it by running:  npm run rebuild   (or: npx electron-rebuild -f -w node-pty)\n'
  );
  throw err;
}

const workspaces = require('./workspaces');
const settings = require('./settings');

// Track every live pty by a renderer-chosen id so we can route data + input.
const ptyProcesses = new Map(); // paneId -> pty process

// =============================================================================
// Shell detection
// =============================================================================
// Probe the system for available shells. Cached after first call.
let cachedShells = null;

function detectShells() {
  if (cachedShells) return cachedShells;

  const shells = [];

  if (process.platform === 'win32') {
    // PowerShell 7+ (pwsh) — check common install locations.
    const pwshPaths = [
      path.join(process.env.ProgramFiles || '', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.ProgramFiles || '', 'PowerShell', '7-preview', 'pwsh.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell', 'pwsh.exe'),
    ];
    for (const p of pwshPaths) {
      if (fs.existsSync(p)) {
        shells.push({ name: 'PowerShell 7', value: p });
        break;
      }
    }
    // Also check if pwsh is on PATH.
    if (!shells.some((s) => s.name === 'PowerShell 7')) {
      try {
        const { execSync } = require('child_process');
        const result = execSync('where pwsh.exe', { encoding: 'utf8', timeout: 3000 }).trim();
        if (result) {
          shells.push({ name: 'PowerShell 7', value: result.split('\n')[0].trim() });
        }
      } catch (_) { /* not on PATH */ }
    }

    // Windows PowerShell 5.1 (always present).
    shells.push({ name: 'Windows PowerShell', value: 'powershell.exe' });

    // Command Prompt.
    shells.push({ name: 'Command Prompt', value: process.env.COMSPEC || 'cmd.exe' });

    // Git Bash.
    const gitBashPaths = [
      path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'bin', 'bash.exe'),
    ];
    for (const p of gitBashPaths) {
      if (fs.existsSync(p)) {
        shells.push({ name: 'Git Bash', value: p });
        break;
      }
    }

    // WSL (Windows Subsystem for Linux).
    const wslPath = path.join(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'wsl.exe');
    if (fs.existsSync(wslPath)) {
      shells.push({ name: 'WSL', value: wslPath });
    }
  } else {
    // macOS / Linux.
    const posixShells = [
      { name: 'Zsh', value: '/bin/zsh' },
      { name: 'Bash', value: '/bin/bash' },
      { name: 'Fish', value: '/usr/bin/fish' },
      { name: 'sh', value: '/bin/sh' },
    ];
    for (const s of posixShells) {
      if (fs.existsSync(s.value)) shells.push(s);
    }
  }

  cachedShells = shells;
  return shells;
}

// Pick a sensible default shell. Prefers pwsh (PowerShell 7) if available.
function platformDefaultShell() {
  if (process.platform === 'win32') {
    const shells = detectShells();
    const pwsh = shells.find((s) => s.name === 'PowerShell 7');
    if (pwsh) return pwsh.value;
    return 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function defaultShell() {
  const configured = settings.getAll().defaultShell;
  return configured || platformDefaultShell();
}

// =============================================================================
// Window
// =============================================================================
let mainWindow = null;

function createWindow() {
  // Frameless windows lose the default Electron menu, which provides the OS-
  // level clipboard accelerators (Ctrl+C/V/X). Without an Edit menu that has
  // the 'paste'/'copy'/'cut' roles, keyboard paste silently does nothing.
  // Setting a hidden menu restores clipboard shortcuts without showing a bar.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0d1117',
    title: 'mod-term',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Uncomment to open devtools for debugging:
  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Intercept close so the renderer can save state before the window dies.
  // The beforeunload event is unreliable for IPC in Electron, so we use a
  // two-step handshake: main asks renderer to save → renderer saves → renderer
  // tells main it's safe to close.
  let closeRequested = false;
  mainWindow.on('close', (e) => {
    if (closeRequested) return; // second pass — actually close
    e.preventDefault();
    mainWindow.webContents.send('app:before-close');
    // Safety net: if the renderer doesn't respond within 3s, close anyway.
    setTimeout(() => {
      closeRequested = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }, 3000);
  });

  ipcMain.once('app:ready-to-close', () => {
    closeRequested = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// =============================================================================
// PTY lifecycle IPC
// =============================================================================

ipcMain.handle('pty:spawn', (_evt, opts = {}) => {
  const paneId = opts.paneId;
  if (!paneId) throw new Error('pty:spawn requires a paneId');

  if (ptyProcesses.has(paneId)) return { paneId, reused: true };

  const shell = opts.shell || defaultShell();
  let cwd = opts.cwd || os.homedir();
  let cwdFallback = false;

  // Validate cwd exists; fall back to home directory if not.
  try {
    if (!fs.statSync(cwd).isDirectory()) { cwd = os.homedir(); cwdFallback = true; }
  } catch (_) {
    cwd = os.homedir();
    cwdFallback = true;
  }

  const proc = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd,
    env: process.env,
  });

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { paneId, data });
    }
  });

  proc.onExit(({ exitCode }) => {
    ptyProcesses.delete(paneId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { paneId, exitCode });
    }
  });

  ptyProcesses.set(paneId, proc);

  // If saved cwd was gone, send a yellow notice into the terminal.
  if (cwdFallback && opts.cwd) {
    const notice =
      `\x1b[33m[mod-term] Saved directory "${opts.cwd}" no longer exists. ` +
      `Opened in ${cwd} instead.\x1b[0m\r\n`;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { paneId, data: notice });
    }
  }

  if (opts.startupCommand) {
    try { proc.write(opts.startupCommand + '\r'); } catch (_) { /* pty died immediately */ }
  }

  return { paneId, shell, cwd, cwdFallback, reused: false };
});

ipcMain.on('pty:input', (_evt, { paneId, data }) => {
  const proc = ptyProcesses.get(paneId);
  if (proc) proc.write(data);
});

ipcMain.on('pty:resize', (_evt, { paneId, cols, rows }) => {
  const proc = ptyProcesses.get(paneId);
  if (proc && cols > 0 && rows > 0) {
    try { proc.resize(cols, rows); } catch (_) { /* process already exited */ }
  }
});

ipcMain.on('pty:kill', (_evt, { paneId }) => {
  const proc = ptyProcesses.get(paneId);
  if (proc) {
    try { proc.kill(); } catch (_) { /* already gone */ }
    ptyProcesses.delete(paneId);
  }
});

// =============================================================================
// App info IPC
// =============================================================================
ipcMain.handle('app:version', () => app.getVersion());

// =============================================================================
// Shell detection IPC
// =============================================================================
ipcMain.handle('shells:list', () => detectShells());

// =============================================================================
// Workspace persistence IPC
// =============================================================================
ipcMain.handle('workspaces:list', () => workspaces.list());
ipcMain.handle('workspaces:load', (_evt, name) => workspaces.load(name));
ipcMain.handle('workspaces:save', (_evt, ws) => workspaces.save(ws));
ipcMain.handle('workspaces:delete', (_evt, name) => workspaces.remove(name));
ipcMain.handle('workspaces:getLast', () => workspaces.getLast());
ipcMain.handle('workspaces:setLast', (_evt, name) => workspaces.setLast(name));

// =============================================================================
// Settings IPC
// =============================================================================
ipcMain.handle('settings:get', () => settings.getAll());
ipcMain.handle('settings:update', (_evt, patch) => settings.update(patch));

// =============================================================================
// Window controls (frameless)
// =============================================================================
ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => { if (mainWindow) mainWindow.close(); });

// =============================================================================
// App lifecycle
// =============================================================================
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const proc of ptyProcesses.values()) {
    try { proc.kill(); } catch (_) { /* already gone */ }
  }
  ptyProcesses.clear();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
