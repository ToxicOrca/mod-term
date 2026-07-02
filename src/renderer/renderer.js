// =============================================================================
// mod-term — Renderer entry point (ES module)
// -----------------------------------------------------------------------------
// Orchestrates the whole UI:
//   - loads settings + themes, applies the dark default
//   - builds the tiling layout tree into the DOM (splits + panes + splitters)
//   - split / close / resize / drag-to-rearrange / drag-to-split / zoom panes
//   - add new terminal panes
//   - directional focus navigation between panes
//   - save & restore workspaces (layout + cwd + startup command) with a
//     quick-switcher, plus "restore last workspace on launch"
//   - a settings modal (theme, font size, default shell, restore-on-launch)
//
// The layout is a recursive tree (see common/layout.js). Because the tree *is*
// the data, saving a workspace is just serializing it.
// =============================================================================

import { makePane, makeSplit, demoLayout, countPanes } from '../common/layout.js';
import { TerminalPane } from './terminal-pane.js';
import * as Theme from './theme.js';
import * as Dialogs from './dialogs.js';

// ---- App state --------------------------------------------------------------
const state = {
  layout: null,                 // root node of the tiling tree
  panes: new Map(),             // paneId -> TerminalPane
  paneEls: new Map(),           // paneId -> the .pane DOM element (cached to avoid xterm re-render)
  activePaneId: null,
  activeThemeName: 'dark',
  currentWorkspaceName: null,
  zoomedPaneId: null,           // when set, that pane is maximized
  settings: null,               // app settings (from main)
  rendering: false,             // guard against concurrent renders
};

const rootEl = document.getElementById('workspace-root');

// Track which panes have had their scrollback dismissed so re-renders
// (from drag/split/etc.) don't bring it back.
const dismissedScrollback = new Set();

// Undo stack: keeps configs of recently closed panes so Ctrl+Z can restore them.
const closedPaneStack = [];

// ---- Boot -------------------------------------------------------------------
async function boot() {
  state.settings = await window.modterm.getSettings();

  // Show version next to brand.
  const ver = await window.modterm.getVersion();
  const verEl = document.getElementById('version');
  if (verEl && ver) verEl.textContent = 'v' + ver;

  await Theme.loadThemes();
  populateThemePicker();

  // Theme priority: localStorage (always written synchronously) > settings file > default.
  const startTheme = localStorage.getItem('mod-term-theme')
    || state.settings.theme
    || Theme.getActiveThemeName();
  const theme = Theme.applyTheme(startTheme);
  if (theme) {
    state.activeThemeName = theme.name;
    document.getElementById('theme-select').value = theme.name;
  }

  wireToolbar();
  wireShortcuts();

  // "Pick up where you left off."
  const last = await window.modterm.getLastWorkspace();
  const restoreMode = state.settings.restoreOnLaunch || 'ask';
  if (last && last.layout && restoreMode !== 'never') {
    if (restoreMode === 'auto') {
      await openWorkspace(last);
      return;
    }
    // restoreMode === 'ask'
    const result = await Dialogs.confirmWithRemember({
      title: `Restore \u201c${last.name}\u201d?`,
      message:
        'Reopen this workspace\u2019s pane layout, cd each pane into its saved ' +
        'folder, and re-run any startup commands?\n\n' +
        'Running processes are re-run fresh, not resumed.',
      okLabel: 'Restore',
      cancelLabel: 'Start fresh',
      rememberLabel: 'Remember my choice',
    });
    if (result.remember) {
      const newMode = result.confirmed ? 'auto' : 'never';
      state.settings = await window.modterm.updateSettings({ restoreOnLaunch: newMode });
    }
    if (result.confirmed) { await openWorkspace(last); return; }
  }

  // Fresh start: the 2-pane demo that proves the tiling concept.
  state.layout = demoLayout();
  await renderLayout();
}

// =============================================================================
// Layout validation & recovery
// =============================================================================
// Ensure the layout tree is structurally valid. Fix common issues (missing
// sizes, empty splits) and return a guaranteed-good tree.
function sanitizeLayout(node) {
  if (!node) return makePane({ title: 'shell' });

  if (node.type === 'pane') return node;

  if (node.type !== 'split' || !Array.isArray(node.children) || node.children.length === 0) {
    return makePane({ title: 'shell' });
  }

  // Recursively sanitize children, drop nulls.
  const kids = [];
  for (const child of node.children) {
    const clean = sanitizeLayout(child);
    if (clean) kids.push(clean);
  }

  if (kids.length === 0) return makePane({ title: 'shell' });
  if (kids.length === 1) return kids[0];

  // Fix sizes: ensure array matches children length, no NaN/negative values.
  let sizes = node.sizes;
  if (!Array.isArray(sizes) || sizes.length !== kids.length ||
      sizes.some((s) => typeof s !== 'number' || isNaN(s) || s <= 0)) {
    sizes = kids.map(() => 1 / kids.length);
  }

  // Normalize so sizes sum to 1.
  const sum = sizes.reduce((s, v) => s + v, 0);
  if (sum > 0 && Math.abs(sum - 1) > 0.001) {
    sizes = sizes.map((v) => v / sum);
  }

  const dir = (node.direction === 'row' || node.direction === 'column')
    ? node.direction : 'row';

  return { type: 'split', direction: dir, children: kids, sizes };
}

// If no active pane or the active pane doesn't exist, pick the first one.
function ensureActivePane() {
  if (state.activePaneId && state.panes.has(state.activePaneId)) return;
  const first = firstPaneId(state.layout);
  if (first) state.activePaneId = first;
}

// =============================================================================
// Rendering the tiling tree
// =============================================================================
// Rebuild the DOM from the layout tree. Existing TerminalPane instances (keyed
// by pane id) are reused so xterm buffers + live shells survive a re-render.
async function renderLayout() {
  // Prevent concurrent renders from stomping on each other.
  if (state.rendering) return;
  state.rendering = true;

  try {
    // Validate the layout before rendering.
    state.layout = sanitizeLayout(state.layout);

    // Collect pane ids that should exist in the new layout.
    const validIds = new Set();
    collectPaneIds(state.layout, validIds);

    // Dispose panes that are no longer in the layout (orphaned by mutations).
    for (const [id, pane] of state.panes) {
      if (!validIds.has(id)) {
        pane.dispose();
        state.panes.delete(id);
        state.paneEls.delete(id);
      }
    }

    // Detach cached pane DOM elements before clearing. They'll be reinserted
    // by buildPane, keeping the xterm element in its original parent so it
    // never triggers an internal re-render (which causes content duplication).
    for (const el of state.paneEls.values()) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    rootEl.innerHTML = '';
    const el = await buildNode(state.layout);
    el.classList.add('root-node');
    rootEl.appendChild(el);

    // Re-apply zoom state if a pane is maximized.
    if (state.zoomedPaneId && !validIds.has(state.zoomedPaneId)) {
      state.zoomedPaneId = null;
    }
    applyZoomClasses();

    requestAnimationFrame(() => {
      for (const pane of state.panes.values()) pane.fit();
    });

    ensureActivePane();
    if (state.activePaneId) setActivePane(state.activePaneId);
  } catch (err) {
    console.error('[mod-term] renderLayout failed, recovering:', err);
    // Emergency recovery: create a single fresh pane.
    state.layout = makePane({ title: 'shell' });
    state.activePaneId = null;
    state.zoomedPaneId = null;
    rootEl.innerHTML = '';
    try {
      const el = await buildNode(state.layout);
      el.classList.add('root-node');
      rootEl.appendChild(el);
      ensureActivePane();
      if (state.activePaneId) setActivePane(state.activePaneId);
    } catch (err2) {
      console.error('[mod-term] recovery also failed:', err2);
    }
  } finally {
    state.rendering = false;
  }
}

function collectPaneIds(node, set) {
  if (!node) return;
  if (node.type === 'pane') { set.add(node.id); return; }
  if (node.children) node.children.forEach((c) => collectPaneIds(c, set));
}

async function buildNode(node) {
  return node.type === 'pane' ? buildPane(node) : buildSplit(node);
}

async function buildSplit(node) {
  const container = document.createElement('div');
  container.className = `split ${node.direction}`;

  for (let i = 0; i < node.children.length; i++) {
    const childEl = await buildNode(node.children[i]);
    childEl.style.flex = `${node.sizes[i]} 1 0%`;
    container.appendChild(childEl);
    if (i < node.children.length - 1) {
      container.appendChild(makeSplitter(node, i, container));
    }
  }
  return container;
}

async function buildPane(node) {
  // If we already have a cached DOM element for this pane, reuse it entirely.
  // This avoids moving the xterm element between parents, which triggers
  // xterm internal re-renders that duplicate viewport content on ConPTY.
  const cached = state.paneEls.get(node.id);
  if (cached && state.panes.has(node.id)) {
    // Update the title in case it changed.
    const titleEl = cached.querySelector('.pane-title');
    if (titleEl) titleEl.textContent = node.title || 'shell';
    // Re-wire drag for the new layout position.
    wireDrag(cached.querySelector('.pane-header'), cached, node);
    requestAnimationFrame(() => {
      const pane = state.panes.get(node.id);
      if (pane) pane.fit();
    });
    return cached;
  }

  const paneEl = document.createElement('div');
  paneEl.className = 'pane';
  paneEl.dataset.paneId = node.id;

  const header = document.createElement('div');
  header.className = 'pane-header';
  header.draggable = true;

  const titleSpan = document.createElement('span');
  titleSpan.className = 'pane-title';
  titleSpan.textContent = node.title || 'shell';
  header.appendChild(titleSpan);

  const hasScrollback = node.scrollback && node.scrollback.length > 0;

  // Header buttons container (right side).
  const btnGroup = document.createElement('span');
  btnGroup.className = 'pane-header-btns';

  // History toggle button — only shown when scrollback data exists.
  const termEl = document.createElement('div');
  termEl.className = 'pane-term';
  let sbPanel = null;

  if (hasScrollback) {
    const histBtn = document.createElement('button');
    histBtn.className = 'pane-header-btn';
    histBtn.textContent = '\u29D6';
    histBtn.title = 'Toggle previous session history';
    histBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sbPanel && sbPanel.parentNode) {
        dismissedScrollback.add(node.id);
        sbPanel.remove();
      } else {
        dismissedScrollback.delete(node.id);
        sbPanel = buildScrollbackPanel(node);
        paneEl.insertBefore(sbPanel, termEl);
      }
    });
    btnGroup.appendChild(histBtn);
  }

  // Settings gear button.
  const configBtn = document.createElement('button');
  configBtn.className = 'pane-header-btn';
  configBtn.textContent = '\u2699';
  configBtn.title = 'Pane settings';
  configBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPaneConfig(node);
  });
  btnGroup.appendChild(configBtn);

  header.appendChild(btnGroup);
  paneEl.appendChild(header);

  // Scrollback panel: shown by default on restore unless previously dismissed.
  const showScrollback = hasScrollback && !dismissedScrollback.has(node.id)
    && !(state.settings && state.settings.scrollbackHidden);
  if (showScrollback) {
    sbPanel = buildScrollbackPanel(node);
    paneEl.appendChild(sbPanel);
  }

  paneEl.appendChild(termEl);

  paneEl.addEventListener('mousedown', () => setActivePane(node.id));

  titleSpan.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(node, titleSpan);
  });
  header.addEventListener('dblclick', () => toggleZoom(node.id));
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openPaneConfig(node);
  });
  wireDrag(header, paneEl, node);

  // Create the terminal and attach it.
  const theme = Theme.applyTheme(state.activeThemeName);
  const pane = new TerminalPane(node, theme, {
    xtermThemeFrom: Theme.xtermThemeFrom,
    fontFor: Theme.fontFor,
  }, {
    onTitle: (paneId, title) => updatePaneTitle(paneId, title),
    onCwd: (paneId, cwd) => { const n = findPane(state.layout, paneId); if (n) n.cwd = cwd; },
    onExit: () => { /* pane keeps its final output; user closes it manually */ },
    onActivity: (paneId) => {
      if (paneId !== state.activePaneId) {
        const hdr = document.querySelector(`.pane[data-pane-id="${paneId}"] .pane-header`);
        if (hdr && !hdr.classList.contains('has-activity')) {
          hdr.classList.add('has-activity');
        }
      }
    },
  });
  state.panes.set(node.id, pane);
  state.paneEls.set(node.id, paneEl);
  await pane.attach(termEl);
  applyFontOverrideTo(pane);

  return paneEl;
}

// =============================================================================
// Splitter (resize between two siblings)
// =============================================================================
function makeSplitter(splitNode, leftIndex, container) {
  const splitter = document.createElement('div');
  splitter.className = 'splitter';

  // Double-click resets the two siblings to equal sizes.
  splitter.addEventListener('dblclick', () => {
    const even = 1 / splitNode.children.length;
    splitNode.sizes = splitNode.children.map(() => even);
    renderLayout();
  });

  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const horizontal = splitNode.direction === 'row';
    const start = horizontal ? e.clientX : e.clientY;
    const total = horizontal ? container.clientWidth : container.clientHeight;
    const startA = splitNode.sizes[leftIndex];
    const startB = splitNode.sizes[leftIndex + 1];
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';

    function onMove(ev) {
      const now = horizontal ? ev.clientX : ev.clientY;
      const deltaFrac = (now - start) / total;
      const min = 0.05;
      let a = startA + deltaFrac;
      let b = startB - deltaFrac;
      if (a < min || b < min) return;
      splitNode.sizes[leftIndex] = a;
      splitNode.sizes[leftIndex + 1] = b;
      const kids = [...container.children].filter((c) => !c.classList.contains('splitter'));
      if (kids[leftIndex]) kids[leftIndex].style.flex = `${a} 1 0%`;
      if (kids[leftIndex + 1]) kids[leftIndex + 1].style.flex = `${b} 1 0%`;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      for (const pane of state.panes.values()) pane.fit();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return splitter;
}

// =============================================================================
// Split / close / add operations
// =============================================================================

// Replace the active pane leaf with a split holding [oldPane, newPane].
async function splitActive(direction) {
  ensureActivePane();
  const activeId = state.activePaneId;
  if (!activeId) return;
  if (state.zoomedPaneId) return;

  const newPaneNode = makePane({ title: 'shell', cwd: inheritCwd(activeId) });
  state.layout = replacePane(state.layout, activeId, (n) =>
    makeSplit(direction, [n, newPaneNode], [0.5, 0.5])
  );

  await renderLayout();
  setActivePane(newPaneNode.id);
}

// Add a brand-new terminal pane to the layout. Appends to the root split,
// or wraps the root in a split if needed.
async function addTerminal() {
  if (state.zoomedPaneId) return;

  const newPaneNode = makePane({ title: 'shell', cwd: inheritCwd(state.activePaneId) });

  if (!state.layout) {
    state.layout = newPaneNode;
  } else if (state.layout.type === 'pane') {
    state.layout = makeSplit('row', [state.layout, newPaneNode], [0.5, 0.5]);
  } else {
    // Append to root split with equal sizes.
    const newChildren = [...state.layout.children, newPaneNode];
    const even = 1 / newChildren.length;
    state.layout = {
      ...state.layout,
      children: newChildren,
      sizes: newChildren.map(() => even),
    };
  }

  await renderLayout();
  setActivePane(newPaneNode.id);
}

// New panes inherit the active pane's current directory.
function inheritCwd(paneId) {
  if (!paneId) return null;
  const n = findPane(state.layout, paneId);
  return n ? n.cwd : null;
}

// Remove the active pane; collapse its parent split if it drops to one child.
async function closeActive() {
  ensureActivePane();
  const activeId = state.activePaneId;
  if (!activeId) return;
  if (countPanes(state.layout) <= 1) return;

  if (state.zoomedPaneId === activeId) state.zoomedPaneId = null;

  // Save the pane config before disposing so Ctrl+Z can restore it.
  const node = findPane(state.layout, activeId);
  if (node) {
    closedPaneStack.push({
      cwd: node.cwd,
      shell: node.shell,
      startupCommand: node.startupCommand,
      title: node.title,
      userTitle: node.userTitle,
    });
    // Cap the stack at 10 entries.
    if (closedPaneStack.length > 10) closedPaneStack.shift();
  }

  const pane = state.panes.get(activeId);
  if (pane) { pane.dispose(); state.panes.delete(activeId); state.paneEls.delete(activeId); }

  state.layout = removeLeaf(state.layout, activeId);
  state.activePaneId = null;
  await renderLayout();
}

// Restore the most recently closed pane.
async function undoClosePane() {
  if (closedPaneStack.length === 0) return;
  if (state.zoomedPaneId) return;

  const config = closedPaneStack.pop();
  const newPaneNode = makePane(config);

  if (!state.layout) {
    state.layout = newPaneNode;
  } else if (state.layout.type === 'pane') {
    state.layout = makeSplit('row', [state.layout, newPaneNode], [0.5, 0.5]);
  } else {
    const newChildren = [...state.layout.children, newPaneNode];
    const even = 1 / newChildren.length;
    state.layout = { ...state.layout, children: newChildren, sizes: newChildren.map(() => even) };
  }

  await renderLayout();
  setActivePane(newPaneNode.id);
  flashToolbar('Restored closed pane');
}

// Recursively rebuild the tree, removing the target leaf and collapsing splits
// that end up with a single child. Sizes are renormalized so they still sum ~1.
function removeLeaf(node, targetId) {
  if (!node) return null;
  if (node.type === 'pane') return node.id === targetId ? null : node;

  const kept = [];
  const keptSizes = [];
  for (let i = 0; i < node.children.length; i++) {
    const res = removeLeaf(node.children[i], targetId);
    if (res) {
      kept.push(res);
      keptSizes.push(node.sizes[i] || (1 / node.children.length));
    }
  }

  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];

  const sum = keptSizes.reduce((s, v) => s + v, 0) || 1;
  return { ...node, children: kept, sizes: keptSizes.map((v) => v / sum) };
}

// Replace a pane node in the tree by id, using a transform function.
function replacePane(node, paneId, transform) {
  if (!node) return node;
  if (node.type === 'pane') {
    return node.id === paneId ? transform(node) : node;
  }
  return {
    ...node,
    children: node.children.map((c) => replacePane(c, paneId, transform)),
    sizes: [...node.sizes],
  };
}

// =============================================================================
// Drag to rearrange
// =============================================================================
// Drag a pane's header onto another pane. The cursor position determines
// which edge to drop on:
//   left/right   -> insert source beside target in a row
//   top/bottom   -> insert source above/below target in a column
// A live indicator shows where the pane will land.
let dragSourceId = null;

// During a drag, xterm's canvas/textarea elements swallow dragover/drop events.
// A transparent overlay on every non-source pane ensures events reach the
// pane-level listener.
function addDragOverlays(sourceId) {
  document.querySelectorAll('.pane').forEach((el) => {
    if (el.dataset.paneId === sourceId) return;
    if (el.querySelector('.drag-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'drag-overlay';
    el.appendChild(overlay);
  });
}
function removeDragOverlays() {
  document.querySelectorAll('.drag-overlay').forEach((el) => el.remove());
}

function wireDrag(header, paneEl, node) {
  header.addEventListener('dragstart', (e) => {
    dragSourceId = node.id;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => addDragOverlays(node.id), 0);
  });
  header.addEventListener('dragend', () => {
    dragSourceId = null;
    removeDragOverlays();
    clearAllDropIndicators();
  });

  paneEl.addEventListener('dragover', (e) => {
    if (!dragSourceId || dragSourceId === node.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showDropIndicator(paneEl, zoneFor(e, paneEl.getBoundingClientRect()));
  });
  paneEl.addEventListener('dragleave', (e) => {
    if (!paneEl.contains(e.relatedTarget)) clearDropIndicator(paneEl);
  });
  paneEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const srcId = dragSourceId;
    dragSourceId = null;
    removeDragOverlays();
    clearAllDropIndicators();
    if (!srcId || srcId === node.id) return;
    const zone = zoneFor(e, paneEl.getBoundingClientRect());
    performDrop(srcId, node.id, zone);
    await renderLayout();
    setActivePane(srcId);
  });
}

// Execute the actual layout mutation for a drop.
function performDrop(sourceId, targetId, zone) {
  // Edge drop: detach source, then insert it next to the target.
  const sourceNode = findPane(state.layout, sourceId);
  if (!sourceNode) return;

  // Detach from current position.
  state.layout = removeLeaf(state.layout, sourceId);
  if (!state.layout) { state.layout = sourceNode; return; }

  const direction = (zone === 'left' || zone === 'right') ? 'row' : 'column';
  const sourceFirst = (zone === 'left' || zone === 'top');

  // Try to insert into an existing same-direction parent split of the target
  // instead of creating a new nested split. This keeps the tree flat.
  const inserted = insertNextTo(state.layout, targetId, sourceNode, direction, sourceFirst);
  if (inserted) {
    state.layout = inserted;
  } else {
    // Fallback: wrap the target in a new split.
    state.layout = replacePane(state.layout, targetId, (tgt) => {
      const kids = sourceFirst ? [sourceNode, tgt] : [tgt, sourceNode];
      return makeSplit(direction, kids, [0.5, 0.5]);
    });
  }
}

// Try to insert sourceNode next to targetId within a parent split that already
// has the right direction. Returns the new tree, or null if not possible.
function insertNextTo(node, targetId, sourceNode, direction, before) {
  if (!node || node.type === 'pane') return null;

  // Check if the target is a direct child of this split.
  const idx = node.children.findIndex(
    (c) => c.type === 'pane' && c.id === targetId
  );

  if (idx >= 0 && node.direction === direction) {
    // Insert source as a sibling in this split.
    const insertAt = before ? idx : idx + 1;
    const newChildren = [...node.children];
    newChildren.splice(insertAt, 0, sourceNode);
    const even = 1 / newChildren.length;
    return { ...node, children: newChildren, sizes: newChildren.map(() => even) };
  }

  // Recurse into children.
  for (let i = 0; i < node.children.length; i++) {
    const result = insertNextTo(node.children[i], targetId, sourceNode, direction, before);
    if (result) {
      const newChildren = [...node.children];
      newChildren[i] = result;
      return { ...node, children: newChildren, sizes: [...node.sizes] };
    }
  }
  return null;
}

// Determine which zone of a pane the cursor is in — always an edge.
// The pane is divided into four triangular quadrants; the cursor position
// determines which edge it maps to (left, right, top, bottom).
function zoneFor(e, rect) {
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const margins = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return Object.keys(margins).reduce((a, b) => (margins[a] < margins[b] ? a : b));
}

function showDropIndicator(paneEl, zone) {
  let ind = paneEl.querySelector('.drop-indicator');
  if (!ind) {
    ind = document.createElement('div');
    ind.className = 'drop-indicator';
    paneEl.appendChild(ind);
  }
  ind.dataset.zone = zone;
}
function clearDropIndicator(paneEl) {
  const ind = paneEl.querySelector('.drop-indicator');
  if (ind) ind.remove();
}
function clearAllDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
}

// =============================================================================
// Focus handling + directional navigation
// =============================================================================
function setActivePane(id) {
  state.activePaneId = id;
  document.querySelectorAll('.pane').forEach((el) => {
    el.classList.toggle('active', el.dataset.paneId === id);
    // Clear activity indicator when pane becomes active.
    if (el.dataset.paneId === id) {
      const hdr = el.querySelector('.pane-header');
      if (hdr) hdr.classList.remove('has-activity');
    }
  });
  const pane = state.panes.get(id);
  if (pane) pane.focus();
}

// Move focus to the nearest pane in a compass direction (Ctrl+Alt+Arrow).
function focusDirection(dir) {
  const active = document.querySelector(`.pane[data-pane-id="${state.activePaneId}"]`);
  if (!active) return;
  const a = active.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;

  let best = null;
  let bestDist = Infinity;
  document.querySelectorAll('.pane').forEach((el) => {
    if (el.dataset.paneId === state.activePaneId) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - ax;
    const dy = cy - ay;
    const ok =
      (dir === 'left' && dx < -1) || (dir === 'right' && dx > 1) ||
      (dir === 'up' && dy < -1) || (dir === 'down' && dy > 1);
    if (!ok) return;
    const dist = (dir === 'left' || dir === 'right')
      ? Math.abs(dx) + Math.abs(dy) * 2
      : Math.abs(dy) + Math.abs(dx) * 2;
    if (dist < bestDist) { bestDist = dist; best = el; }
  });
  if (best) setActivePane(best.dataset.paneId);
}

// =============================================================================
// Zoom / maximize a pane
// =============================================================================
function toggleZoom(id) {
  state.zoomedPaneId = (state.zoomedPaneId === id) ? null : id;
  applyZoomClasses();
  const pane = state.panes.get(state.zoomedPaneId || id);
  if (pane) requestAnimationFrame(() => { pane.fit(); pane.focus(); });
}

function applyZoomClasses() {
  const zid = state.zoomedPaneId;
  rootEl.classList.toggle('has-zoom', !!zid);
  document.querySelectorAll('.pane').forEach((el) => {
    el.classList.toggle('zoomed', el.dataset.paneId === zid);
  });
}

// =============================================================================
// Themes + fonts
// =============================================================================
function populateThemePicker() {
  const select = document.getElementById('theme-select');
  select.innerHTML = '';
  for (const { name, label } of Theme.themeNames()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.value = Theme.getActiveThemeName();
  select.addEventListener('change', () => applyThemeByName(select.value, true));
}

function applyThemeByName(name, persist) {
  const theme = Theme.applyTheme(name);
  if (!theme) return;
  state.activeThemeName = theme.name;
  document.getElementById('theme-select').value = theme.name;
  for (const pane of state.panes.values()) pane.setTheme(theme);

  // Always save to localStorage (synchronous, immediate, survives restart).
  localStorage.setItem('mod-term-theme', theme.name);

  // Also persist to settings file for consistency.
  if (persist) {
    window.modterm.updateSettings({ theme: theme.name }).catch(() => {});
  }
}

// =============================================================================
// Per-pane config (cwd, shell, startup command)
// =============================================================================
async function openPaneConfig(node) {
  const detectedShells = await window.modterm.listShells();
  const shellOptions = [
    { value: '', label: 'Default' },
    ...detectedShells.map((sh) => ({ value: sh.value, label: sh.name })),
  ];

  const result = await Dialogs.form({
    title: `Pane settings \u2014 ${node.title || 'shell'}`,
    fields: [
      { key: 'cwd', label: 'Working directory', type: 'text',
        value: node.cwd || '', placeholder: 'e.g. C:\\Projects\\my-app',
        hint: 'Directory the shell starts in. Leave blank for home directory.' },
      { key: 'shell', label: 'Shell', type: 'select',
        value: node.shell || '', options: shellOptions },
      { key: 'startupCommand', label: 'Startup command', type: 'text',
        value: node.startupCommand || '', placeholder: 'e.g. npm run dev',
        hint: 'Run automatically when this pane opens on restore.' },
    ],
  });
  if (!result) return;

  node.cwd = result.cwd || null;
  node.shell = result.shell || null;
  node.startupCommand = result.startupCommand || null;

  // Offer to restart the pane so changes take effect now.
  const restart = await Dialogs.confirm({
    title: 'Restart pane?',
    message: 'Apply changes now by restarting this shell?\nUnsaved work in this terminal will be lost.',
    okLabel: 'Restart now',
    cancelLabel: 'Apply on next restore',
  });
  if (restart) {
    const pane = state.panes.get(node.id);
    if (pane) { pane.dispose(); state.panes.delete(node.id); state.paneEls.delete(node.id); }
    await renderLayout();
  }
}

function applyFontOverrideTo(pane) {
  const s = state.settings || {};
  if (s.fontSize || s.fontFamily) {
    pane.setFontOverride({ size: s.fontSize, family: s.fontFamily });
  }
}

// =============================================================================
// Settings modal
// =============================================================================
async function openSettings() {
  const s = state.settings;
  const themeOptions = Theme.themeNames().map((t) => ({ value: t.name, label: t.label }));

  // Build shell options from detected shells.
  const detectedShells = await window.modterm.listShells();
  const shellOptions = [
    { value: '', label: 'Auto-detect (default)' },
    ...detectedShells.map((sh) => ({ value: sh.value, label: sh.name })),
  ];

  const result = await Dialogs.form({
    title: 'Settings',
    fields: [
      { key: 'theme', label: 'Default theme', type: 'select', value: s.theme, options: themeOptions,
        hint: 'Applied now and used for new sessions.' },
      { key: 'fontSize', label: 'Terminal font size (px)', type: 'number', value: s.fontSize,
        placeholder: 'theme default', hint: 'Leave blank to use the theme\u2019s size.' },
      { key: 'defaultShell', label: 'Default shell', type: 'select', value: s.defaultShell || '',
        options: shellOptions, hint: 'Shell used for new terminal panes.' },
      { key: 'restoreOnLaunch', label: 'On launch', type: 'select',
        value: s.restoreOnLaunch || 'ask',
        options: [
          { value: 'auto', label: 'Auto-restore last workspace' },
          { value: 'ask', label: 'Ask whether to restore' },
          { value: 'never', label: 'Always start fresh' },
        ],
        hint: 'What to do when a previous workspace exists at startup.' },
      { key: 'saveScrollback', label: 'Save scrollback with workspaces',
        type: 'checkbox', value: s.saveScrollback,
        hint: 'Include terminal output in saved workspaces. Replayed as dimmed text on restore.' },
      { key: 'scrollbackLines', label: 'Scrollback lines to save', type: 'number',
        value: s.scrollbackLines, placeholder: '200',
        hint: 'Max lines of terminal output saved per pane (1\u20131000).' },
      { key: 'scrollbackHidden', label: 'Start with history hidden',
        type: 'checkbox', value: s.scrollbackHidden,
        hint: 'History panels start collapsed on restore. Toggle per-pane with the \u29D6 button.' },
    ],
  });
  if (!result) return;

  // Convert empty string back to null for "auto-detect".
  if (result.defaultShell === '') result.defaultShell = null;

  state.settings = await window.modterm.updateSettings(result);

  applyThemeByName(state.settings.theme, false);
  for (const pane of state.panes.values()) applyFontOverrideTo(pane);
}

// =============================================================================
// Workspaces
// =============================================================================

// Build the scrollback DOM panel for a pane node.
function buildScrollbackPanel(node) {
  const panel = document.createElement('div');
  panel.className = 'scrollback-panel';

  const label = document.createElement('div');
  label.className = 'scrollback-label';
  label.textContent = 'previous session';
  panel.appendChild(label);

  const content = document.createElement('pre');
  content.className = 'scrollback-content';
  content.textContent = node.scrollback.join('\n');
  panel.appendChild(content);

  return panel;
}

// Capture the last N lines from a pane's xterm buffer as plain text.
// Wrapped in try/catch so a buffer API failure never prevents saving.
function captureScrollback(paneId, maxLines) {
  try {
    const pane = state.panes.get(paneId);
    if (!pane || !pane.term) return null;
    const buf = pane.term.buffer.active;
    if (!buf) return null;
    const totalLines = buf.length;
    const startLine = Math.max(0, totalLines - maxLines);
    const lines = [];
    for (let i = startLine; i < totalLines; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.length > 0 ? lines : null;
  } catch (err) {
    console.error('[mod-term] captureScrollback failed for pane', paneId, err);
    return null;
  }
}

// Walk the layout tree and attach scrollback arrays to pane nodes.
function attachScrollback(node, maxLines) {
  if (!node) return node;
  if (node.type === 'pane') {
    return { ...node, scrollback: captureScrollback(node.id, maxLines) };
  }
  return { ...node, children: node.children.map((c) => attachScrollback(c, maxLines)) };
}

// Build a workspace payload from the current state.
// includeScrollback: true for auto-save (always), controlled by setting for manual save.
function buildWorkspaceSnapshot(name, includeScrollback) {
  let layoutToSave = state.layout;
  if (includeScrollback) {
    const s = state.settings || {};
    const maxLines = Math.min(Math.max(s.scrollbackLines || 200, 1), 1000);
    try {
      layoutToSave = attachScrollback(state.layout, maxLines);
    } catch (err) {
      console.error('[mod-term] scrollback capture failed, saving without it:', err);
    }
  }
  return {
    name,
    theme: state.activeThemeName,
    layout: layoutToSave,
    activePaneId: state.activePaneId,
    zoomedPaneId: state.zoomedPaneId,
  };
}

async function saveCurrentWorkspace() {
  const name = await Dialogs.prompt({
    title: 'Save workspace',
    label: 'Name',
    value: state.currentWorkspaceName || 'my-project',
    placeholder: 'e.g. daily-projects',
  });
  if (!name) return;

  await window.modterm.saveWorkspace(buildWorkspaceSnapshot(name, !!state.settings.saveScrollback));
  await window.modterm.setLastWorkspace(name);
  state.currentWorkspaceName = name;
  flashToolbar(`Saved "${name}"`);
}

// Auto-save: persists the current state (including scrollback) so the user
// doesn't have to manually Ctrl+S for the restore to be up-to-date.
async function autoSave() {
  if (!state.layout || state.panes.size === 0) return;
  const name = state.currentWorkspaceName || '__autosave';
  try {
    await window.modterm.saveWorkspace(buildWorkspaceSnapshot(name, true));
    await window.modterm.setLastWorkspace(name);
  } catch (err) {
    console.error('[mod-term] auto-save failed:', err);
  }
}

// Auto-save every 30 seconds.
setInterval(autoSave, 30_000);

// Save-before-close: main process intercepts the window close, asks us to
// save, we save with full scrollback, then signal it's safe to close.
window.modterm.onBeforeClose(async () => {
  try {
    await autoSave();
  } catch (err) {
    console.error('[mod-term] save-on-close failed:', err);
  }
  window.modterm.readyToClose();
});

async function openWorkspace(ws) {
  for (const pane of state.panes.values()) pane.dispose();
  state.panes.clear();
  state.paneEls.clear();
  state.activePaneId = null;
  state.zoomedPaneId = null;
  dismissedScrollback.clear();

  // Theme is a user preference, not a per-workspace setting — don't override it.
  // Only apply the workspace theme if the user hasn't chosen one yet.
  if (ws.theme && !localStorage.getItem('mod-term-theme')) {
    applyThemeByName(ws.theme, false);
  }

  const { node: newLayout, idMap } = reidLayout(ws.layout);
  state.layout = newLayout;
  state.currentWorkspaceName = ws.name;

  // Restore active/zoomed pane using the old → new ID mapping.
  if (ws.activePaneId && idMap.has(ws.activePaneId)) {
    state.activePaneId = idMap.get(ws.activePaneId);
  }
  if (ws.zoomedPaneId && idMap.has(ws.zoomedPaneId)) {
    state.zoomedPaneId = idMap.get(ws.zoomedPaneId);
  }

  await window.modterm.setLastWorkspace(ws.name);
  await renderLayout();
  flashToolbar(`Opened "${ws.name}"`);
}

// Give every pane in a loaded tree a fresh id (clean pty spawn), preserving
// cwd / shell / startupCommand / title. Returns { node, idMap } where idMap
// maps old pane ids to new ones so activePaneId/zoomedPaneId can be remapped.
function reidLayout(node, idMap) {
  if (!idMap) idMap = new Map();
  if (!node) {
    const p = makePane({ title: 'shell' });
    return { node: p, idMap };
  }
  if (node.type === 'pane') {
    const p = makePane({
      cwd: node.cwd,
      shell: node.shell,
      startupCommand: node.startupCommand,
      title: node.title,
      userTitle: node.userTitle,
    });
    if (node.scrollback) p.scrollback = node.scrollback;
    if (node.id) idMap.set(node.id, p.id);
    return { node: p, idMap };
  }
  const newChildren = (node.children || []).map((c) => reidLayout(c, idMap).node);
  return {
    node: { ...node, children: newChildren, sizes: [...(node.sizes || [])] },
    idMap,
  };
}

// =============================================================================
// Quick-switcher
// =============================================================================
async function openSwitcher() {
  const overlay = document.getElementById('switcher-overlay');
  const input = document.getElementById('switcher-input');
  const listEl = document.getElementById('switcher-list');
  const all = await window.modterm.listWorkspaces();

  let filtered = all;
  let selected = 0;

  function render() {
    listEl.innerHTML = '';
    filtered.forEach((w, i) => {
      const li = document.createElement('li');
      if (i === selected) li.classList.add('selected');
      li.innerHTML =
        `<span>${escapeHtml(w.name)}</span>` +
        `<span class="meta">${w.paneCount} panes \u00b7 ${escapeHtml(w.theme)}</span>`;
      li.addEventListener('click', () => choose(w.name));
      listEl.appendChild(li);
    });
    if (filtered.length === 0) {
      listEl.innerHTML =
        '<li class="meta">No saved workspaces yet \u2014 use Save workspace to create one.</li>';
    }
  }

  async function choose(name) {
    closeSwitcher();
    const ws = await window.modterm.loadWorkspace(name);
    if (ws) await openWorkspace(ws);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeSwitcher(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1); return render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); return render(); }
    if (e.key === 'Enter' && filtered[selected]) { e.preventDefault(); return choose(filtered[selected].name); }
  }
  function onInput() {
    const q = input.value.toLowerCase();
    filtered = all.filter((w) => w.name.toLowerCase().includes(q));
    selected = 0;
    render();
  }
  function closeSwitcher() {
    overlay.classList.add('hidden');
    // Use capture:true to match how they were added.
    document.removeEventListener('keydown', onKey, true);
    input.removeEventListener('input', onInput);
    overlay.removeEventListener('mousedown', onBackdrop);
  }
  function onBackdrop(e) { if (e.target === overlay) closeSwitcher(); }

  overlay.classList.remove('hidden');
  input.value = '';
  // Listen on document in capture phase so we get Esc before xterm does.
  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', onInput);
  overlay.addEventListener('mousedown', onBackdrop);
  render();
  input.focus();
}

// =============================================================================
// Toolbar + shortcuts
// =============================================================================
function wireToolbar() {
  document.getElementById('btn-new-term').onclick = () => addTerminal();
  document.getElementById('btn-split-h').onclick = () => splitActive('row');
  document.getElementById('btn-split-v').onclick = () => splitActive('column');
  document.getElementById('btn-close-pane').onclick = () => closeActive();
  document.getElementById('btn-save-workspace').onclick = () => saveCurrentWorkspace();
  document.getElementById('btn-workspaces').onclick = () => openSwitcher();
  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) settingsBtn.onclick = () => openSettings();

  // Frameless window controls.
  document.getElementById('btn-minimize').onclick = () => window.modterm.minimizeWindow();
  document.getElementById('btn-maximize').onclick = () => window.modterm.maximizeWindow();
  document.getElementById('btn-close-window').onclick = () => window.modterm.closeWindow();
}

function wireShortcuts() {
  // Use the CAPTURE phase so our shortcuts fire before xterm's internal
  // key handler. Without this, xterm intercepts keys like Ctrl+Z and sends
  // them to the shell (producing a beep) before we can preventDefault.
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && k === 't') { e.preventDefault(); e.stopPropagation(); addTerminal(); }
    else if (e.ctrlKey && e.shiftKey && k === 'd') { e.preventDefault(); e.stopPropagation(); splitActive('row'); }
    else if (e.ctrlKey && e.shiftKey && k === 'e') { e.preventDefault(); e.stopPropagation(); splitActive('column'); }
    else if (e.ctrlKey && e.shiftKey && k === 'w') { e.preventDefault(); e.stopPropagation(); closeActive(); }
    else if (e.ctrlKey && e.shiftKey && k === 'z') { e.preventDefault(); e.stopPropagation(); if (state.activePaneId) toggleZoom(state.activePaneId); }
    else if (e.ctrlKey && !e.shiftKey && k === 'z') { e.preventDefault(); e.stopPropagation(); undoClosePane(); }
    else if (e.ctrlKey && e.altKey && k === 'arrowleft') { e.preventDefault(); e.stopPropagation(); focusDirection('left'); }
    else if (e.ctrlKey && e.altKey && k === 'arrowright') { e.preventDefault(); e.stopPropagation(); focusDirection('right'); }
    else if (e.ctrlKey && e.altKey && k === 'arrowup') { e.preventDefault(); e.stopPropagation(); focusDirection('up'); }
    else if (e.ctrlKey && e.altKey && k === 'arrowdown') { e.preventDefault(); e.stopPropagation(); focusDirection('down'); }
    else if (e.ctrlKey && k === 'p') { e.preventDefault(); e.stopPropagation(); openSwitcher(); }
    else if (e.ctrlKey && k === 's') { e.preventDefault(); e.stopPropagation(); saveCurrentWorkspace(); }
    else if (e.ctrlKey && e.key === ',') { e.preventDefault(); e.stopPropagation(); openSettings(); }
  }, true); // true = capture phase

  window.addEventListener('resize', () => {
    for (const pane of state.panes.values()) pane.fit();
  });
}

// Called by OSC 0/2 title changes from the shell. If the user has manually
// renamed a pane, the user name sticks and shell titles are ignored.
function updatePaneTitle(paneId, title) {
  const n = findPane(state.layout, paneId);
  if (!n || n.userTitle) return; // user-set name takes priority
  n.title = title;
  const el = document.querySelector(`.pane[data-pane-id="${paneId}"] .pane-title`);
  if (el) el.textContent = title;
}

// Inline rename: turns the title span into an editable input field.
function startRename(node, titleSpan) {
  // Don't start a second rename if one is active.
  if (titleSpan.querySelector('input')) return;

  const currentName = node.title || 'shell';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pane-rename-input';
  input.value = currentName;

  titleSpan.textContent = '';
  titleSpan.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    cleanup();
    if (val && val !== currentName) {
      node.title = val;
      node.userTitle = true; // lock against OSC overwrite
      titleSpan.textContent = val;
    } else {
      titleSpan.textContent = currentName;
    }
    // Re-focus the terminal.
    const pane = state.panes.get(node.id);
    if (pane) pane.focus();
  }
  function cancel() {
    cleanup();
    titleSpan.textContent = currentName;
    const pane = state.panes.get(node.id);
    if (pane) pane.focus();
  }
  function cleanup() {
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('keydown', onKey);
  }
  function onBlur() { commit(); }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation(); // don't let shortcuts fire while typing
  }

  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', onKey);
}

function flashToolbar(msg) {
  const brand = document.getElementById('brand');
  const original = 'mod-term';
  brand.textContent = `mod-term \u2014 ${msg}`;
  setTimeout(() => { brand.textContent = original; }, 1800);
}

// =============================================================================
// Tiny tree helpers
// =============================================================================
function firstPaneId(node) {
  if (!node) return null;
  if (node.type === 'pane') return node.id;
  if (node.children) {
    for (const c of node.children) { const id = firstPaneId(c); if (id) return id; }
  }
  return null;
}
function findPane(node, id) {
  if (!node || !id) return null;
  if (node.type === 'pane') return node.id === id ? node : null;
  if (node.children) {
    for (const c of node.children) { const f = findPane(c, id); if (f) return f; }
  }
  return null;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Go.
boot().catch((err) => {
  document.body.innerHTML =
    `<pre style="color:#ff7b72;padding:20px">mod-term failed to start:\n\n${err.stack || err}</pre>`;
});
