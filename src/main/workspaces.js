// =============================================================================
// mod-term — Workspace persistence (MAIN process module)
// -----------------------------------------------------------------------------
// A "workspace" is a saved, named arrangement of terminals. Instead of
// reopening each project's terminal by hand (and forgetting some), you save
// the whole set once and restore it.
//
// IMPORTANT — honest design note:
//   We CANNOT freeze and thaw a live running process. There is no way to snapshot
//   a running `npm run dev` and resume it byte-for-byte. So "pick up where you
//   left off" here means, exactly like tmuxinator / VS Code's restore:
//       - restore the pane LAYOUT (the split arrangement + sizes),
//       - restore each pane's WORKING DIRECTORY,
//       - re-run each pane's optional STARTUP COMMAND (e.g. `npm run dev`, `claude`).
//   Scrollback history and in-flight process state are not preserved.
//
// Storage: a single JSON file in Electron's userData dir, so it survives app
// restarts and lives outside the project tree.
// =============================================================================

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function storePath() {
  return path.join(app.getPath('userData'), 'workspaces.json');
}

// Shape of the store on disk:
// {
//   "lastWorkspace": "my-project",
//   "workspaces": {
//     "my-project": {
//       "name": "my-project",
//       "theme": "dark",
//       "layout": { ...nested split tree, see common/layout.js... }
//     }
//   }
// }
function readStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.workspaces) parsed.workspaces = {};
    return parsed;
  } catch (_) {
    // First run or unreadable file — start clean.
    return { lastWorkspace: null, workspaces: {} };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

// Return an array of workspace summaries for the picker.
// Internal workspaces (names starting with __) are hidden from the UI.
function list() {
  const store = readStore();
  return Object.values(store.workspaces)
    .filter((w) => !w.name.startsWith('__'))
    .map((w) => ({
      name: w.name,
      paneCount: Array.isArray(w.tabs)
        ? w.tabs.reduce((s, t) => s + countPanes(t.layout), 0)
        : countPanes(w.layout),
      tabCount: Array.isArray(w.tabs) ? w.tabs.length : 1,
      theme: w.theme || 'dark',
    }));
}

function load(name) {
  const store = readStore();
  return store.workspaces[name] || null;
}

// ws must include at least { name } plus either tabs[] (current format) or
// layout (legacy single-tree format). theme optional.
function save(ws) {
  if (!ws || !ws.name) throw new Error('workspace requires a name');
  const store = readStore();
  const entry = {
    name: ws.name,
    theme: ws.theme || 'dark',
    savedAt: new Date().toISOString(),
  };
  if (Array.isArray(ws.tabs)) {
    // Current format: one layout tree per tab.
    entry.tabs = ws.tabs;
    entry.activeTabIndex = ws.activeTabIndex || 0;
  } else {
    // Legacy format (kept so old renderer versions round-trip cleanly).
    entry.layout = ws.layout;
    entry.activePaneId = ws.activePaneId || null;
    entry.zoomedPaneId = ws.zoomedPaneId || null;
  }
  store.workspaces[ws.name] = entry;
  writeStore(store);
  return true;
}

function remove(name) {
  const store = readStore();
  delete store.workspaces[name];
  if (store.lastWorkspace === name) store.lastWorkspace = null;
  writeStore(store);
  return true;
}

function getLast() {
  const store = readStore();
  if (!store.lastWorkspace) return null;
  return store.workspaces[store.lastWorkspace] || null;
}

function setLast(name) {
  const store = readStore();
  store.lastWorkspace = name;
  writeStore(store);
  return true;
}

// Walk the nested split tree and count leaf panes (terminals).
function countPanes(node) {
  if (!node) return 0;
  if (node.type === 'pane') return 1;
  if (node.type === 'split') {
    return (node.children || []).reduce((sum, c) => sum + countPanes(c), 0);
  }
  return 0;
}

module.exports = { list, load, save, remove, getLast, setLast };
