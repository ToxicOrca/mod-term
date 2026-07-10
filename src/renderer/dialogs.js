// =============================================================================
// mod-term — In-app modal dialogs (renderer, ES module)
// -----------------------------------------------------------------------------
// Replaces the browser's window.confirm/window.prompt (which are jarring,
// unstyleable, and block the event loop) with dark-themed, promise-returning
// modals that match the app. All three resolve to a value (or null on cancel).
//
//   confirm({ title, message, okLabel, cancelLabel }) -> Promise<boolean>
//   prompt({ title, label, value, placeholder })      -> Promise<string|null>
//   form({ title, fields })                           -> Promise<object|null>
//
// A `field` is { key, label, type, value, options?, placeholder?, hint? }
//   type: 'text' | 'number' | 'checkbox' | 'select'
//   options (for select): [{ value, label }]
//
// Only one modal shows at a time; ESC cancels, Enter confirms (except inside a
// textarea). Clicking the backdrop cancels.
// =============================================================================

let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.id = 'dialog-host';
  document.body.appendChild(host);
  return host;
}

// Core renderer used by all three helpers. `build` populates the body and
// returns a function that computes the resolve value on OK.
function openModal({ title, build, okLabel = 'OK', cancelLabel = 'Cancel', okOnly = false }) {
  return new Promise((resolve) => {
    const root = ensureHost();

    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const h = document.createElement('div');
    h.className = 'modal-title';
    h.textContent = title || '';
    modal.appendChild(h);

    const body = document.createElement('div');
    body.className = 'modal-body';
    modal.appendChild(body);

    const getValue = build(body); // may return a value-getter fn

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const okBtn = document.createElement('button');
    okBtn.className = 'primary';
    okBtn.textContent = okLabel;

    let cancelBtn = null;
    if (!okOnly) {
      cancelBtn = document.createElement('button');
      cancelBtn.textContent = cancelLabel;
      actions.appendChild(cancelBtn);
    }
    actions.appendChild(okBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    root.appendChild(overlay);

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function confirm() {
      const val = getValue ? getValue() : true;
      cleanup();
      resolve(val);
    }
    function cancel() {
      cleanup();
      resolve(okOnly ? true : null);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); confirm(); }
    }

    okBtn.addEventListener('click', confirm);
    if (cancelBtn) cancelBtn.addEventListener('click', cancel);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cancel(); });
    document.addEventListener('keydown', onKey, true);

    // Focus the first focusable control, else the OK button.
    const firstInput = body.querySelector('input, select, textarea');
    (firstInput || okBtn).focus();
    if (firstInput && firstInput.select) firstInput.select();
  });
}

export function confirm({ title, message, okLabel = 'OK', cancelLabel = 'Cancel' }) {
  return openModal({
    title,
    okLabel,
    cancelLabel,
    build: (body) => {
      const p = document.createElement('p');
      p.className = 'modal-message';
      p.textContent = message || '';
      body.appendChild(p);
      return () => true;
    },
  });
}

// Like confirm(), but with a "Remember my choice" checkbox.
// Resolves to { confirmed: boolean, remember: boolean }.
export function confirmWithRemember({ title, message, okLabel = 'OK', cancelLabel = 'Cancel', rememberLabel = 'Remember my choice' }) {
  let rememberCb;
  return openModal({
    title,
    okLabel,
    cancelLabel,
    build: (body) => {
      const p = document.createElement('p');
      p.className = 'modal-message';
      p.textContent = message || '';
      body.appendChild(p);

      const wrap = document.createElement('label');
      wrap.className = 'modal-check';
      rememberCb = document.createElement('input');
      rememberCb.type = 'checkbox';
      wrap.appendChild(rememberCb);
      wrap.appendChild(document.createTextNode(' ' + rememberLabel));
      body.appendChild(wrap);

      return () => ({ confirmed: true, remember: rememberCb.checked });
    },
  }).then((result) => {
    if (result) return result;
    // Cancel was clicked — still check the remember box.
    return { confirmed: false, remember: rememberCb ? rememberCb.checked : false };
  });
}

export function alert({ title, message, okLabel = 'OK' }) {
  return openModal({
    title,
    okLabel,
    okOnly: true,
    build: (body) => {
      const p = document.createElement('p');
      p.className = 'modal-message';
      p.textContent = message || '';
      body.appendChild(p);
      return () => true;
    },
  });
}

// Read-only keyboard-shortcut reference, rendered as grouped two-column grids.
// groups: [{ title, items: [[keys, description], ...] }, ...]
export function shortcuts({ title, groups }) {
  return openModal({
    title,
    okLabel: 'Close',
    okOnly: true,
    build: (body) => {
      for (const g of groups) {
        const h = document.createElement('div');
        h.className = 'shortcut-group-title';
        h.textContent = g.title;
        body.appendChild(h);

        const grid = document.createElement('div');
        grid.className = 'shortcut-grid';
        for (const [keys, desc] of g.items) {
          const kEl = document.createElement('span');
          kEl.className = 'shortcut-keys';
          kEl.textContent = keys;
          grid.appendChild(kEl);
          const dEl = document.createElement('span');
          dEl.className = 'shortcut-desc';
          dEl.textContent = desc;
          grid.appendChild(dEl);
        }
        body.appendChild(grid);
      }
      return () => true;
    },
  });
}

export function prompt({ title, label, value = '', placeholder = '' }) {
  return openModal({
    title,
    okLabel: 'Save',
    build: (body) => {
      if (label) {
        const l = document.createElement('label');
        l.className = 'modal-label';
        l.textContent = label;
        body.appendChild(l);
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.placeholder = placeholder;
      body.appendChild(input);
      return () => input.value.trim() || null;
    },
  });
}

export function form({ title, fields, okLabel = 'Save' }) {
  return openModal({
    title,
    okLabel,
    build: (body) => {
      const controls = {};
      for (const f of fields) {
        const wrap = document.createElement('div');
        wrap.className = 'modal-field';

        if (f.type === 'checkbox') {
          const l = document.createElement('label');
          l.className = 'modal-check';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!f.value;
          l.appendChild(cb);
          l.appendChild(document.createTextNode(' ' + (f.label || f.key)));
          wrap.appendChild(l);
          controls[f.key] = () => cb.checked;
        } else if (f.type === 'select') {
          const l = document.createElement('label');
          l.className = 'modal-label';
          l.textContent = f.label || f.key;
          wrap.appendChild(l);
          const sel = document.createElement('select');
          for (const opt of f.options || []) {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            sel.appendChild(o);
          }
          sel.value = f.value != null ? String(f.value) : '';
          wrap.appendChild(sel);
          controls[f.key] = () => sel.value;
        } else {
          const l = document.createElement('label');
          l.className = 'modal-label';
          l.textContent = f.label || f.key;
          wrap.appendChild(l);
          const input = document.createElement('input');
          input.type = f.type === 'number' ? 'number' : 'text';
          input.value = f.value != null ? String(f.value) : '';
          if (f.placeholder) input.placeholder = f.placeholder;
          wrap.appendChild(input);
          controls[f.key] = () =>
            f.type === 'number'
              ? (input.value === '' ? null : Number(input.value))
              : (input.value.trim() === '' ? null : input.value.trim());
        }

        if (f.hint) {
          const hint = document.createElement('div');
          hint.className = 'modal-hint';
          hint.textContent = f.hint;
          wrap.appendChild(hint);
        }
        body.appendChild(wrap);
      }
      return () => {
        const out = {};
        for (const key of Object.keys(controls)) out[key] = controls[key]();
        return out;
      };
    },
  });
}
