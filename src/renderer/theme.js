// =============================================================================
// mod-term — Theme loader (renderer, ES module)
// -----------------------------------------------------------------------------
// Themes are DATA, not code. Each theme is a JSON file in /themes. To add one,
// drop a JSON file in that folder and list it in themes/index.json — no code
// changes. This module:
//   - fetches the theme index + every theme file,
//   - applies a theme by pushing UI colors into CSS variables,
//   - exposes the terminal color block for xterm instances to consume.
// =============================================================================

const THEME_DIR = '../../themes';

let themes = {};       // name -> theme object
let defaultName = 'dark';
let activeName = 'dark';

export async function loadThemes() {
  const index = await fetch(`${THEME_DIR}/index.json`).then((r) => r.json());
  defaultName = index.default || 'dark';

  const files = index.themes || [];
  const loaded = await Promise.all(
    files.map((f) => fetch(`${THEME_DIR}/${f}`).then((r) => r.json()))
  );
  themes = {};
  for (const t of loaded) themes[t.name] = t;
  return themes;
}

export function themeNames() {
  return Object.values(themes).map((t) => ({ name: t.name, label: t.label || t.name }));
}

export function getActiveThemeName() {
  return activeName;
}

// Apply a theme to the UI chrome (CSS variables). Returns the theme object so
// the caller can hand terminal colors to xterm.
export function applyTheme(name) {
  const theme = themes[name] || themes[defaultName];
  if (!theme) return null;
  activeName = theme.name;

  const root = document.documentElement.style;
  const ui = theme.ui || {};
  root.setProperty('--app-bg', ui.appBackground);
  root.setProperty('--chrome-bg', ui.chromeBackground);
  root.setProperty('--chrome-text', ui.chromeText);
  root.setProperty('--accent', ui.accent);
  root.setProperty('--pane-border', ui.paneBorder);
  root.setProperty('--pane-border-active', ui.paneBorderActive);
  root.setProperty('--splitter-hover', ui.splitterHover);
  if (theme.font && theme.font.family) {
    root.setProperty('--font-family', theme.font.family);
  }
  return theme;
}

// Build the object xterm expects for `theme:` from a mod-term theme.
export function xtermThemeFrom(theme) {
  const t = (theme && theme.terminal) || {};
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    black: t.black, red: t.red, green: t.green, yellow: t.yellow,
    blue: t.blue, magenta: t.magenta, cyan: t.cyan, white: t.white,
    brightBlack: t.brightBlack, brightRed: t.brightRed, brightGreen: t.brightGreen,
    brightYellow: t.brightYellow, brightBlue: t.brightBlue, brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan, brightWhite: t.brightWhite,
  };
}

export function fontFor(theme) {
  const f = (theme && theme.font) || {};
  return {
    fontFamily: f.family || 'Consolas, monospace',
    fontSize: f.size || 14,
    lineHeight: f.lineHeight || 1.2,
  };
}
