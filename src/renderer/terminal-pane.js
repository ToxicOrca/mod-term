// =============================================================================
// mod-term — TerminalPane (renderer, ES module)
// -----------------------------------------------------------------------------
// Wraps a single xterm.js terminal bound to one node-pty shell in the main
// process. One TerminalPane == one leaf in the layout tree == one shell.
//
// Data flow:
//   keystrokes:  xterm.onData -> modterm.sendInput -> main -> pty.write
//   output:      pty.onData (main) -> 'pty:data' -> this.write() -> xterm
//   resize:      FitAddon -> modterm.resizePty -> main -> pty.resize
//
// xterm globals (Terminal, FitAddon, WebLinksAddon) come from the UMD <script>
// tags in index.html.
// =============================================================================

export class TerminalPane {
  /**
   * @param {object} node    the layout leaf node (has id, cwd, shell, startupCommand)
   * @param {object} theme   active mod-term theme object
   * @param {object} helpers { xtermThemeFrom, fontFor }  (from theme.js)
   * @param {object} callbacks { onTitle(paneId, title), onCwd(paneId, cwd), onExit(paneId, code) }
   */
  constructor(node, theme, helpers, callbacks = {}) {
    this.node = node;
    this.paneId = node.id;
    this.theme = theme;
    this.helpers = helpers;
    this.callbacks = callbacks;
    // liveCwd is the working directory the shell most recently reported via
    // OSC 7. It's what "Save workspace" captures so restore lands in the folder
    // you were actually in — not just where the pane started. Falls back to the
    // node's configured cwd when the shell doesn't emit OSC 7 (see setupShellIntegration in README).
    this.liveCwd = node.cwd || null;
    this._unsubData = null;
    this._unsubExit = null;

    const font = helpers.fontFor(theme);
    this.term = new window.Terminal({
      cursorBlink: true,
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      lineHeight: font.lineHeight,
      theme: helpers.xtermThemeFrom(theme),
      allowProposedApi: true,
    });

    this.fitAddon = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    // Web links addon opens URLs in the OS browser rather than inside the app.
    if (window.WebLinksAddon) {
      this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    }
  }

  // Mount into a DOM element, spawn the shell, wire the streams.
  async attach(el) {
    this.term.open(el);
    this.fit();

    // --- Shell integration: track cwd + title ------------------------------
    // OSC 7 is the de-facto standard for a shell to report its cwd:
    //   ESC ] 7 ; file://HOST/PATH BEL
    // If the shell is configured to emit it (see README), we keep liveCwd fresh
    // so workspace saves capture the real folder. If not, liveCwd stays at the
    // pane's configured cwd — degraded gracefully, never wrong.
    this.term.parser.registerOscHandler(7, (payload) => {
      const cwd = parseOsc7(payload);
      if (cwd) {
        this.liveCwd = cwd;
        if (this.callbacks.onCwd) this.callbacks.onCwd(this.paneId, cwd);
      }
      return true; // handled
    });

    // Title changes (OSC 0/2) let the pane header reflect the running program.
    this.term.onTitleChange((title) => {
      if (title && this.callbacks.onTitle) this.callbacks.onTitle(this.paneId, title);
    });

    // Wire listeners BEFORE spawning so we don't miss early output (e.g. cwd
    // fallback notices sent by the main process during spawn).
    this._unsubData = window.modterm.onPtyData(({ paneId, data }) => {
      if (paneId === this.paneId) {
        this.term.write(data);
        if (this.callbacks.onActivity) this.callbacks.onActivity(this.paneId);
      }
    });
    this._unsubExit = window.modterm.onPtyExit(({ paneId, exitCode }) => {
      if (paneId === this.paneId) {
        this.term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
        this.exited = true;
        if (this.callbacks.onExit) this.callbacks.onExit(this.paneId, exitCode);
      }
    });

    // Send keystrokes upstream.
    this.term.onData((data) => window.modterm.sendInput(this.paneId, data));

    // Spawn the real shell in the main process.
    const spawnResult = await window.modterm.spawnPty({
      paneId: this.paneId,
      cwd: this.node.cwd || undefined,
      shell: this.node.shell || undefined,
      cols: this.term.cols,
      rows: this.term.rows,
      startupCommand: this.node.startupCommand || undefined,
    });

    // If the saved cwd didn't exist, update the node so future saves use
    // the real path instead of the stale one.
    if (spawnResult && spawnResult.cwdFallback) {
      this.node.cwd = spawnResult.cwd;
      this.liveCwd = spawnResult.cwd;
    }

  }

  fit() {
    try {
      this.fitAddon.fit();
      const { cols, rows } = this.term;
      if (cols !== this._lastCols || rows !== this._lastRows) {
        this._lastCols = cols;
        this._lastRows = rows;
        // Debounce the pty resize so rapid layout changes (drag, window
        // resize) only fire once after the layout stabilizes.
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => {
          window.modterm.resizePty(this.paneId, cols, rows);
        }, 100);
      }
    } catch (_) { /* element not sized yet */ }
  }

  focus() { this.term.focus(); }

  // Re-theme a live terminal (used when the user switches themes).
  // A user font override (from Settings) wins over the theme's own font.
  setTheme(theme) {
    this.theme = theme;
    this.term.options.theme = this.helpers.xtermThemeFrom(theme);
    const font = this.helpers.fontFor(theme);
    const o = this.fontOverride || {};
    this.term.options.fontFamily = o.family || font.fontFamily;
    this.term.options.fontSize = o.size || font.fontSize;
    this.fit();
  }

  // Apply a user font override (null values fall back to the theme's font).
  setFontOverride(o) {
    this.fontOverride = o || {};
    this.setTheme(this.theme);
  }

  dispose() {
    if (this._unsubData) this._unsubData();
    if (this._unsubExit) this._unsubExit();
    window.modterm.killPty(this.paneId);
    this.term.dispose();
  }
}

// Parse an OSC 7 payload ("file://HOST/PATH") into a filesystem path.
// On Windows the path arrives as "/C:/Users/name" -> "C:\Users\name".
function parseOsc7(payload) {
  if (!payload || !payload.startsWith('file://')) return null;
  try {
    const withoutScheme = payload.slice('file://'.length);
    const slash = withoutScheme.indexOf('/');
    let p = slash >= 0 ? withoutScheme.slice(slash) : withoutScheme;
    p = decodeURIComponent(p);
    // Windows drive path: strip the leading slash and switch separators.
    if (/^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1).replace(/\//g, '\\');
    }
    return p;
  } catch (_) {
    return null;
  }
}
