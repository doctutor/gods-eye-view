/**
 * Personal fork: the Walk and Fly Controls card, opened from the gear
 * beside Move (src/navigation/presentation.js) in every mode: the
 * settings of src/navigation/settings.js, and the key bindings rebound by
 * pressing a key ("Press a key…": Esc cancels, Backspace clears).
 */
import { formatNumber, msg, t } from '../i18n/index.js';
import { ACTIONS, BOUNDS, navSettings } from './settings.js';

export const ACTION_LABELS = Object.freeze({
  forward: msg('Forward'),
  back: msg('Back'),
  left: msg('Left'),
  right: msg('Right'),
  jump: msg('Jump (Fly: up)'),
  sneak: msg('Sneak (Fly: down)'),
  sprint: msg('Sprint'),
  up: msg('Fly up'),
  down: msg('Fly down'),
  walkHere: msg('Walk here'),
  flyHere: msg('Fly here'),
  release: msg('Release the pointer'),
  view: msg('Cycle the view'),
  home: msg('Set home (Shift: go home)'),
});

const KEY_NAMES = Object.freeze({
  Space: msg('Space'),
  ShiftLeft: msg('Left Shift'),
  ShiftRight: msg('Right Shift'),
  ControlLeft: msg('Left Ctrl'),
  ControlRight: msg('Right Ctrl'),
  AltLeft: msg('Left Alt'),
  AltRight: msg('Right Alt'),
  Enter: msg('Enter'),
  Tab: msg('Tab'),
  CapsLock: msg('Caps Lock'),
});
const KEY_SYMBOLS = Object.freeze({
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
});

/** A key's name for the card, from its `event.code`. */
export function keyLabel(code) {
  if (!code) return '—';
  if (KEY_NAMES[code]) return t(KEY_NAMES[code]);
  if (KEY_SYMBOLS[code]) return KEY_SYMBOLS[code];
  const letter = /^Key([A-Z])$/.exec(code) || /^Digit(\d)$/.exec(code);
  if (letter) return letter[1];
  const pad = /^Numpad(.+)$/.exec(code);
  if (pad) return t('Numpad {key}', { key: pad[1] });
  return code;
}

/** What the card says when a key is refused (settings.check's verdict). */
export function refusalMessage(verdict, code) {
  const key = keyLabel(code);
  if (verdict.reason === 'app')
    return t('{key} is one of the app’s own shortcuts', { key });
  if (verdict.reason === 'browser')
    return t('{key} belongs to the browser (Ctrl+W closes the tab)', { key });
  if (verdict.reason === 'taken')
    return t('{key} is already {action}', {
      key,
      action: t(ACTION_LABELS[verdict.by] ?? verdict.by),
    });
  return t('{key} cannot be bound', { key });
}

/**
 * The key capture: `start(action)`, then each keydown's `key(event)` →
 * {outcome: 'cancelled' | 'cleared' | 'bound' | 'refused', message}.
 * Esc cancels, Backspace clears; a refused key keeps it listening.
 */
export function createKeyCapture(settings) {
  let action = null;
  return {
    get action() {
      return action;
    },
    start(next) {
      action = ACTIONS.includes(next) ? next : null;
      return action;
    },
    cancel() {
      action = null;
    },
    key(event) {
      if (!action) return null;
      const code = event?.code;
      if (code === 'Escape') {
        action = null;
        return { outcome: 'cancelled', message: '' };
      }
      if (code === 'Backspace') {
        const which = action;
        settings.unbind(which);
        action = null;
        return {
          outcome: 'cleared',
          message: t('{action}: no key', { action: t(ACTION_LABELS[which]) }),
        };
      }
      const verdict = settings.bind(action, code);
      if (!verdict.ok)
        return { outcome: 'refused', message: refusalMessage(verdict, code) };
      const which = action;
      action = null;
      return {
        outcome: 'bound',
        message: t('{action}: {key}', {
          action: t(ACTION_LABELS[which]),
          key: keyLabel(code),
        }),
      };
    },
  };
}

const el = (doc, tag, className, text) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/**
 * The card: {element, destroy}. Its controls write straight to the
 * settings, which the binding reads each frame (so they apply at once).
 */
export function createNavControlsCard(
  doc,
  { settings = navSettings(), onClose = null } = {},
) {
  const card = el(doc, 'div', 'nav-controls-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('Walk and Fly controls'));
  const head = el(doc, 'div', 'nav-controls-head');
  head.append(
    el(doc, 'span', 'nav-controls-title', t('Walk and Fly controls')),
  );
  const close = el(doc, 'button', 'nav-controls-close', '×');
  close.type = 'button';
  close.title = t('Close');
  close.setAttribute('aria-label', t('Close'));
  head.append(close);
  card.append(head);

  const syncs = [];
  const row = (label, control, unit) => {
    const line = el(doc, 'label', 'nav-controls-row');
    line.append(el(doc, 'span', 'nav-controls-label', label), control);
    if (unit) line.append(unit);
    card.append(line);
  };
  const range = (key, label, step, show) => {
    const input = el(doc, 'input');
    input.type = 'range';
    [input.min, input.max] = BOUNDS[key].map(String);
    input.step = String(step);
    const out = el(doc, 'output', 'nav-controls-value');
    input.addEventListener('input', () =>
      settings.set({ [key]: Number(input.value) }),
    );
    syncs.push((s) => {
      input.value = String(s[key]);
      out.textContent = show(s[key]);
    });
    row(label, input, out);
  };
  const number = (key, label) => {
    const input = el(doc, 'input', 'nav-controls-number');
    input.type = 'number';
    [input.min, input.max] = BOUNDS[key].map(String);
    input.step = '0.1';
    input.addEventListener('change', () => {
      if (input.value !== '') settings.set({ [key]: Number(input.value) });
      input.value = String(settings.get()[key]);
    });
    syncs.push((s) => {
      if (doc.activeElement !== input) input.value = String(s[key]);
    });
    row(label, input, el(doc, 'span', 'nav-controls-unit', t('m/s')));
  };
  const check = (key, label) => {
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.addEventListener('change', () =>
      settings.set({ [key]: input.checked }),
    );
    syncs.push((s) => (input.checked = Boolean(s[key])));
    row(label, input);
  };

  range('sensitivity', t('Mouse sensitivity'), 0.05, (v) =>
    t('{value}×', { value: formatNumber(v, { maximumFractionDigits: 2 }) }),
  );
  check('invertY', t('Invert the mouse’s Y'));
  range('fovDeg', t('Field of view (vertical)'), 1, (v) =>
    t('{value}°', { value: formatNumber(Math.round(v)) }),
  );
  number('walk', t('Walk speed'));
  number('sprint', t('Sprint speed'));
  number('fly', t('Fly speed'));
  const sneak = el(doc, 'select');
  for (const [value, label] of [
    ['hold', t('Hold')],
    ['toggle', t('Toggle')],
  ]) {
    const option = el(doc, 'option', null, label);
    option.value = value;
    sneak.append(option);
  }
  sneak.addEventListener('change', () =>
    settings.set({ sneakMode: sneak.value }),
  );
  syncs.push((s) => (sneak.value = s.sneakMode));
  row(t('Sneak'), sneak);
  check('sprintFov', t('Sprinting widens the view'));
  check('bobbing', t('View bobbing'));

  // Other sources' sections (a gamepad's), under their own headings.
  const offSections = [];
  for (const section of settings.sections?.() ?? []) {
    card.append(el(doc, 'div', 'nav-controls-section', t(section.title)));
    const applies = [];
    for (const spec of section.rows) {
      const input = el(doc, 'input');
      input.type = spec.type === 'toggle' ? 'checkbox' : 'range';
      const out =
        spec.type === 'range' && el(doc, 'output', 'nav-controls-value');
      if (spec.type === 'range') {
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
      }
      input.addEventListener(spec.type === 'toggle' ? 'change' : 'input', () =>
        section.set({
          [spec.key]:
            spec.type === 'toggle' ? input.checked : Number(input.value),
        }),
      );
      applies.push((values) => {
        if (spec.type === 'toggle') input.checked = Boolean(values[spec.key]);
        else {
          input.value = String(values[spec.key]);
          out.textContent = formatNumber(values[spec.key], {
            maximumFractionDigits: 2,
          });
        }
      });
      row(t(spec.label), input, out || null);
    }
    const apply = (values = section.get()) => {
      for (const fn of applies) fn(values);
    };
    apply();
    offSections.push(section.subscribe(apply));
  }

  // The keys: a button an action; a click listens for the next key.
  card.append(el(doc, 'div', 'nav-controls-section', t('Keys')));
  const keys = el(doc, 'div', 'nav-controls-keys');
  card.append(keys);
  const status = el(doc, 'div', 'nav-controls-status');
  status.setAttribute('aria-live', 'polite');
  const capture = createKeyCapture(settings);
  const buttons = new Map();
  const label = (action) => {
    const codes = settings.codesFor(action);
    return codes.length ? codes.map(keyLabel).join(' / ') : '—';
  };
  const showKeys = () => {
    for (const [action, button] of buttons) {
      const listening = capture.action === action;
      button.textContent = listening ? t('Press a key…') : label(action);
      button.classList.toggle('is-listening', listening);
      button.setAttribute('aria-pressed', String(listening));
    }
  };
  // Keys taken on the button itself (a form control to the walker and to
  // the app's shortcuts), stopped there so neither hears them.
  const onCaptureKey = (event) => {
    if (!capture.action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const result = capture.key(event);
    if (result) status.textContent = result.message;
    showKeys();
  };
  for (const action of ACTIONS) {
    keys.append(
      el(doc, 'span', 'nav-controls-label', t(ACTION_LABELS[action])),
    );
    const button = el(doc, 'button', 'nav-controls-key');
    button.type = 'button';
    button.addEventListener('click', () => {
      capture.start(capture.action === action ? null : action);
      status.textContent = capture.action
        ? t('Press a key for {action} (Esc cancels, Backspace clears)', {
            action: t(ACTION_LABELS[action]),
          })
        : '';
      showKeys();
    });
    button.addEventListener('keydown', onCaptureKey);
    button.addEventListener('blur', () => {
      if (capture.action !== action) return;
      capture.cancel();
      showKeys();
    });
    buttons.set(action, button);
    keys.append(button);
  }
  card.append(status);

  const reset = el(doc, 'button', 'nav-controls-reset', t('Reset to defaults'));
  reset.type = 'button';
  reset.addEventListener('click', () => {
    capture.cancel();
    settings.reset();
    status.textContent = t('Controls reset to the defaults');
  });
  card.append(reset);

  const sync = (s = settings.get()) => {
    for (const apply of syncs) apply(s);
    showKeys();
  };
  const unsubscribe = settings.subscribe(sync);
  sync();
  // Esc outside a capture closes the card; keys typed here stay here.
  const onCardKey = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape' && !capture.action) onClose?.();
  };
  card.addEventListener('keydown', onCardKey);
  card.addEventListener('keyup', (event) => event.stopPropagation());
  close.addEventListener('click', () => onClose?.());
  return {
    element: card,
    get capturing() {
      return capture.action;
    },
    destroy() {
      unsubscribe();
      for (const off of offSections) off();
      capture.cancel();
      card.removeEventListener('keydown', onCardKey);
      card.remove();
    },
  };
}

/**
 * The gear beside Move: {element, destroy}. It opens the card under
 * itself (in the page's body, so the layer panel does not clip it).
 */
export function createNavControlsButton(
  doc,
  { settings = navSettings() } = {},
) {
  const gear = el(doc, 'button', 'nav-controls-btn', '⚙');
  gear.type = 'button';
  gear.title = t('Walk and Fly controls: mouse, view, speeds and keys');
  gear.setAttribute('aria-label', t('Walk and Fly controls'));
  gear.setAttribute('aria-haspopup', 'dialog');
  gear.setAttribute('aria-expanded', 'false');
  let card = null;
  const onOutside = (event) => {
    if (!card) return;
    if (card.element.contains(event.target) || gear.contains(event.target))
      return;
    hide();
  };
  const hide = () => {
    if (!card) return;
    card.destroy();
    card = null;
    gear.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('pointerdown', onOutside, true);
  };
  const show = () => {
    card = createNavControlsCard(doc, {
      settings,
      onClose: () => {
        hide();
        gear.focus?.();
      },
    });
    doc.body.append(card.element);
    const rect = gear.getBoundingClientRect?.();
    const view = doc.defaultView;
    if (rect && view) {
      const width = card.element.offsetWidth || 280;
      const left = Math.max(
        8,
        Math.min(rect.right - width, view.innerWidth - width - 8),
      );
      card.element.style.left = `${Math.round(left)}px`;
      card.element.style.top = `${Math.round(rect.bottom + 6)}px`;
    }
    gear.setAttribute('aria-expanded', 'true');
    doc.addEventListener('pointerdown', onOutside, true);
    card.element.querySelector('input, select, button')?.focus?.();
  };
  const onClick = () => (card ? hide() : show());
  gear.addEventListener('click', onClick);
  return {
    element: gear,
    get open() {
      return Boolean(card);
    },
    destroy() {
      hide();
      gear.removeEventListener('click', onClick);
    },
  };
}
