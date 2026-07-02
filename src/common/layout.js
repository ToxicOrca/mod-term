// =============================================================================
// mod-term — Layout model (shared shape, ES module)
// -----------------------------------------------------------------------------
// The pane arrangement is a recursive tree. This same shape is what gets
// serialized into a workspace, so the tiling arrangement round-trips to disk.
//
//   Leaf:  { type: 'pane', id, cwd, shell?, startupCommand?, title? }
//   Split: { type: 'split', direction: 'row'|'column', sizes: [..], children: [node,..] }
//
//  - direction 'row'    => panes sit side-by-side (a vertical splitter between)
//  - direction 'column' => panes stack top/bottom (a horizontal splitter between)
//  - sizes[]            => flex fractions, one per child, summing to ~1
//
// Pure / no-DOM so it can be reasoned about and unit-tested on its own.
// Loaded by the renderer as an ES module.
// =============================================================================

let paneCounter = 0;
export function newPaneId() {
  paneCounter += 1;
  return `pane-${Date.now().toString(36)}-${paneCounter}`;
}

export function makePane(opts = {}) {
  const pane = {
    type: 'pane',
    id: opts.id || newPaneId(),
    cwd: opts.cwd || null,               // null => shell default (home)
    shell: opts.shell || null,           // null => platform default
    startupCommand: opts.startupCommand || null,
    title: opts.title || 'shell',
  };
  if (opts.userTitle) pane.userTitle = true; // user-set name, immune to OSC overwrites
  return pane;
}

export function makeSplit(direction, children, sizes) {
  const kids = children || [];
  return {
    type: 'split',
    direction, // 'row' | 'column'
    children: kids,
    sizes: sizes || kids.map(() => 1 / (kids.length || 1)),
  };
}

// The 2-pane demo layout for first run: two side-by-side terminals.
export function demoLayout() {
  return makeSplit('row', [
    makePane({ title: 'left' }),
    makePane({ title: 'right' }),
  ]);
}

// Count leaf panes in a tree.
export function countPanes(node) {
  if (!node) return 0;
  if (node.type === 'pane') return 1;
  if (node.type === 'split') {
    return (node.children || []).reduce((s, c) => s + countPanes(c), 0);
  }
  return 0;
}
