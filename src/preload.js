// =============================================================================
// mod-term — Preload bridge
// -----------------------------------------------------------------------------
// contextIsolation is ON, so the renderer has NO direct access to Node or
// Electron. This file runs in a privileged context and exposes exactly the
// small, named API the renderer is allowed to call — nothing more. This keeps
// the attack surface tiny (a terminal renders untrusted program output, so we
// don't want it to have arbitrary Node access).
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modterm', {
  // ---- PTY control -------------------------------------------------------
  spawnPty: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  sendInput: (paneId, data) => ipcRenderer.send('pty:input', { paneId, data }),
  resizePty: (paneId, cols, rows) =>
    ipcRenderer.send('pty:resize', { paneId, cols, rows }),
  killPty: (paneId) => ipcRenderer.send('pty:kill', { paneId }),

  // Subscriptions. Return an unsubscribe fn so panes can clean up.
  onPtyData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },

  // ---- Workspaces --------------------------------------------------------
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  loadWorkspace: (name) => ipcRenderer.invoke('workspaces:load', name),
  saveWorkspace: (ws) => ipcRenderer.invoke('workspaces:save', ws),
  deleteWorkspace: (name) => ipcRenderer.invoke('workspaces:delete', name),
  getLastWorkspace: () => ipcRenderer.invoke('workspaces:getLast'),
  setLastWorkspace: (name) => ipcRenderer.invoke('workspaces:setLast', name),

  // ---- Shells -------------------------------------------------------------
  listShells: () => ipcRenderer.invoke('shells:list'),

  // ---- Settings ----------------------------------------------------------
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  // ---- App info ----------------------------------------------------------
  getVersion: () => ipcRenderer.invoke('app:version'),

  // ---- Window controls (frameless) --------------------------------------
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // ---- Lifecycle ---------------------------------------------------------
  // Main process asks renderer to save before closing.
  onBeforeClose: (cb) => {
    ipcRenderer.on('app:before-close', cb);
  },
  readyToClose: () => ipcRenderer.send('app:ready-to-close'),
});
