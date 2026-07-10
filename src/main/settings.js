// =============================================================================
// mod-term — App settings (MAIN process module)
// -----------------------------------------------------------------------------
// Small, durable key/value settings persisted to disk in Electron's userData
// dir (next to workspaces.json). These are app-wide preferences, distinct from
// per-workspace data:
//   - restoreOnLaunch : 'auto' | 'ask' | 'never'
//   - theme           : default theme name for new sessions
//   - defaultShell    : override the platform default shell (null = auto)
//   - fontSize / fontFamily : terminal font overrides (null = use theme's)
//
// Kept deliberately tiny and defensive: a missing/corrupt file yields defaults.
// =============================================================================

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  restoreOnLaunch: 'ask',       // 'auto' | 'ask' | 'never'
  theme: 'dark',
  defaultShell: null,           // null => platform default (PowerShell on Windows)
  fontSize: null,               // null => use the active theme's font size
  fontFamily: null,             // null => use the active theme's font family
  saveScrollback: false,        // save terminal output with workspaces
  scrollbackLines: 200,         // max lines of output to save per pane
  scrollbackHidden: false,      // start with history panels collapsed
});

function storePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function read() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = { ...DEFAULTS, ...JSON.parse(raw) };

    // Migrate old boolean restoreLastOnLaunch → 3-way restoreOnLaunch.
    if ('restoreLastOnLaunch' in parsed) {
      if (parsed.restoreLastOnLaunch === true) parsed.restoreOnLaunch = 'auto';
      delete parsed.restoreLastOnLaunch;
    }

    return parsed;
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function write(next) {
  const merged = { ...DEFAULTS, ...next };
  // Drop the old key if it sneaked in.
  delete merged.restoreLastOnLaunch;

  // Validate values so a bad patch can't corrupt settings.
  if (!['auto', 'ask', 'never'].includes(merged.restoreOnLaunch)) {
    merged.restoreOnLaunch = DEFAULTS.restoreOnLaunch;
  }
  if (merged.fontSize != null && (typeof merged.fontSize !== 'number' || merged.fontSize < 6 || merged.fontSize > 72)) {
    merged.fontSize = DEFAULTS.fontSize;
  }
  if (merged.fontFamily != null && typeof merged.fontFamily !== 'string') {
    merged.fontFamily = DEFAULTS.fontFamily;
  }
  if (merged.scrollbackLines != null) {
    merged.scrollbackLines = Math.min(Math.max(Number(merged.scrollbackLines) || 200, 1), 1000);
  }

  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function getAll() {
  return read();
}

function update(patch) {
  const current = read();
  return write({ ...current, ...(patch || {}) });
}

module.exports = { DEFAULTS, getAll, update };
