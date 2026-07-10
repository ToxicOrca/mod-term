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

// ---- Global pty event dispatch ---------------------------------------------
// One IPC listener per channel for the whole app, dispatching by paneId via a
// Map. The naive per-pane approach (each pane adds its own ipcRenderer.on and
// filters by id) costs O(panes) handler runs per output chunk and trips Node's
// MaxListenersExceededWarning at 11 panes.
const dataHandlers = new Map(); // paneId -> (data) => void
const exitHandlers = new Map(); // paneId -> (exitCode) => void
let globalWired = false;

function ensureGlobalPtyListeners() {
  if (globalWired) return;
  globalWired = true;
  window.modterm.onPtyData(({ paneId, data }) => {
    const h = dataHandlers.get(paneId);
    if (h) h(data);
  });
  window.modterm.onPtyExit(({ paneId, exitCode }) => {
    const h = exitHandlers.get(paneId);
    if (h) h(exitCode);
  });
}

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
    this.exited = false;

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
    // Search addon powers the Ctrl+Shift+F find bar (see renderer.js).
    if (window.SearchAddon) {
      this.searchAddon = new window.SearchAddon.SearchAddon();
      this.term.loadAddon(this.searchAddon);
    }
    // Serialize addon captures the buffer WITH colors for workspace saves.
    if (window.SerializeAddon) {
      this.serializeAddon = new window.SerializeAddon.SerializeAddon();
      this.term.loadAddon(this.serializeAddon);
    }
  }

  // Mount into a DOM element, spawn the shell, wire the streams.
  async attach(el) {
    this.term.open(el);

    // GPU-accelerated renderer — noticeably faster with heavy output. Must be
    // loaded after open(). Browsers cap the number of live WebGL contexts
    // (~16), so on context loss we dispose the addon and xterm falls back to
    // its DOM renderer for that pane.
    if (window.WebglAddon) {
      try {
        const webgl = new window.WebglAddon.WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch (_) { /* already gone */ } });
        this.term.loadAddon(webgl);
      } catch (_) { /* no GPU — DOM renderer is fine */ }
    }

    this.fit();

    // Replay the previous session's output (captured with colors by the
    // serialize addon) straight into the buffer, followed by a dim divider.
    // The shell's first prompt then prints right below it.
    if (this.node.scrollbackAnsi) {
      this.term.write(this.node.scrollbackAnsi);
      this.term.write('\x1b[0m\r\n\x1b[90m─── previous session ───\x1b[0m\r\n');
    }

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
    ensureGlobalPtyListeners();
    dataHandlers.set(this.paneId, (data) => {
      this.term.write(data);
      if (this.callbacks.onActivity) this.callbacks.onActivity(this.paneId);
    });
    exitHandlers.set(this.paneId, (exitCode) => {
      this.term.write(
        `\r\n\x1b[90m[process exited with code ${exitCode} — press Enter to relaunch]\x1b[0m\r\n`
      );
      this.exited = true;
      if (this.callbacks.onExit) this.callbacks.onExit(this.paneId, exitCode);
    });

    // Send keystrokes upstream. After the shell exits, the pane keeps its
    // final output; Enter relaunches the shell in place.
    this.term.onData((data) => {
      if (this.exited) {
        if (data === '\r') this.respawn();
        return;
      }
      window.modterm.sendInput(this.paneId, data);
    });

    await this._spawn();
  }

  // Spawn (or re-spawn) the shell for this pane.
  async _spawn() {
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

  // Capture up to maxLines of scrollback as an ANSI string (colors intact).
  // Returns null if the serialize addon isn't available or capture fails.
  serializeScrollback(maxLines) {
    if (!this.serializeAddon) return null;
    try {
      const out = this.serializeAddon.serialize({ scrollback: maxLines });
      return out && out.trim() ? out : null;
    } catch (err) {
      console.error('[mod-term] serialize failed for pane', this.paneId, err);
      return null;
    }
  }

  // Relaunch the shell after it exited (main process removed the dead pty
  // from its map on exit, so the paneId is free to reuse).
  async respawn() {
    if (!this.exited) return;
    this.exited = false;
    this.term.reset();
    await this._spawn();
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
    dataHandlers.delete(this.paneId);
    exitHandlers.delete(this.paneId);
    clearTimeout(this._resizeTimer);
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
