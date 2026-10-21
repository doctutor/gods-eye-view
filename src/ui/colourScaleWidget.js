import { msg, t } from '../i18n/index.js';
import {
  PALETTES,
  SCALES,
  formatScaleValue,
  isDefaultScale,
  paletteGradient,
  rangeFraction,
  rangeValue,
  resolveWindow,
  scaleLegend,
} from '../maps/colourScale.js';

/**
 * Personal fork: the "Scale" controls under a layer row that paints values
 * through a colour ramp (src/maps/colourScale.js). A SCALE chip opens:
 * a palette drop-down with a preview of the ramp; a two-handle window over
 * the layer's data range (floor and ceiling, on the scale's own mapping)
 * with number inputs in the layer's units (empty: automatic); LINEAR, LOG
 * (and SQRT where it is the layer's own); INVERT; HIDE OUTSIDE (values
 * beyond the window clear rather than painted the end colours); RESET.
 * Every control is a native button, select, range or number input, so the
 * keyboard reaches and works all of them. Nodes are kept across the
 * panel's refreshes; an input being used is never overwritten.
 *
 * A layer offers it by returning `scale: scaleRowControl({...})` from
 * getRowControls(), and its legend from `scaleRowLegend(...)`.
 */

const SLIDER_STEPS = 1000;

const SCALE_WORDS = Object.freeze({
  linear: msg('LINEAR'),
  log: msg('LOG'),
  sqrt: msg('SQRT'),
});

/**
 * The row descriptor for a scale key, bound to the store.
 * @param {{store: object, key: string, defaults: object,
 *   auto?: {min: number, max: number}|null,
 *   range?: {min: number, max: number}|null}} input `auto`: the window
 *   when none is set (the layer's data domain, else its fixed range);
 *   `range`: the slider's bounds (default: auto).
 */
export function scaleRowControl({
  store,
  key,
  defaults,
  auto = null,
  range = null,
}) {
  const model = store.get(key, defaults);
  const autoRange = auto || defaults.range || null;
  return {
    key,
    model,
    defaults,
    auto: autoRange,
    range: widenRange(range || autoRange, model),
    onChange: (partial) => store.set(key, partial),
    onReset: () => store.reset(key),
  };
}

/** The legend for a row from its scale (stops labelled in the layer's units). */
export function scaleRowLegend(descriptor, options) {
  if (!descriptor) return [];
  return scaleLegend(
    descriptor.model,
    descriptor.defaults,
    descriptor.auto,
    options,
  ).map(({ label, color }) => ({ label, color }));
}

/** The slider's bounds reach any window set outside the data range. */
function widenRange(range, model) {
  if (!range || !(range.max > range.min)) return range;
  let { min, max } = range;
  if (model.floor !== null) min = Math.min(min, model.floor);
  if (model.ceiling !== null) max = Math.max(max, model.ceiling);
  return { min, max };
}

/**
 * What the controls show for a descriptor (pure, for tests): the window in
 * force, the handles' positions (0 to SLIDER_STEPS), the inputs' text, the
 * mappings offered.
 */
export function scaleControlState(descriptor) {
  const { model, defaults, auto, range } = descriptor;
  const window = resolveWindow(model, auto);
  const mapping = model.scale;
  const handle = (value) =>
    window && range
      ? Math.round(rangeFraction(value, range, mapping) * SLIDER_STEPS)
      : 0;
  return {
    window,
    floorHandle: window ? handle(window.floor) : 0,
    ceilingHandle: window ? handle(window.ceiling) : SLIDER_STEPS,
    floorText: model.floor === null ? '' : String(model.floor),
    ceilingText: model.ceiling === null ? '' : String(model.ceiling),
    floorPlaceholder: window ? formatScaleValue(window.floor) : '',
    ceilingPlaceholder: window ? formatScaleValue(window.ceiling) : '',
    // SQRT only where it is the layer's own mapping (Elevation).
    scales: SCALES.filter(
      (scale) => scale !== 'sqrt' || defaults.model.scale === 'sqrt',
    ),
    isDefault: isDefaultScale(model, defaults),
    units: defaults.units || '',
  };
}

/**
 * The value a handle at `position` (0 to SLIDER_STEPS) means, kept a
 * hair inside the other handle, rounded to 3 significant figures.
 */
export function handleValue(descriptor, which, position) {
  const { model, auto, range } = descriptor;
  const window = resolveWindow(model, auto);
  if (!range || !window) return null;
  let value = rangeValue(position / SLIDER_STEPS, range, model.scale);
  value = Number(value.toPrecision(3));
  if (which === 'floor' && !(value < window.ceiling))
    value = Number(
      rangeValue(
        Math.max(0, rangeFraction(window.ceiling, range, model.scale) - 0.01),
        range,
        model.scale,
      ).toPrecision(3),
    );
  if (which === 'ceiling' && !(value > window.floor))
    value = Number(
      rangeValue(
        Math.min(1, rangeFraction(window.floor, range, model.scale) + 0.01),
        range,
        model.scale,
      ).toPrecision(3),
    );
  return value;
}

const el = (doc, tag, className, props = {}) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  Object.assign(node, props);
  return node;
};
const setIfChanged = (node, name, value) => {
  if (node[name] !== value) node[name] = value;
};
const focused = (node) => node.ownerDocument?.activeElement === node;

/** Build the widget's nodes once; handlers read the live descriptor. */
function buildWidget(doc, live) {
  const root = el(doc, 'div', 'data-scale');
  const toggle = el(doc, 'button', 'data-toggle-chip data-scale-toggle', {
    type: 'button',
  });
  toggle.setAttribute('aria-expanded', 'false');
  const body = el(doc, 'div', 'data-scale-body');
  body.hidden = true;
  const bodyId = `data-scale-${Math.random().toString(36).slice(2, 10)}`;
  body.id = bodyId;
  toggle.setAttribute('aria-controls', bodyId);
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    root.classList.toggle('open', open);
  });

  // Palette and its preview.
  const paletteRow = el(doc, 'div', 'data-scale-line');
  const paletteLabel = el(doc, 'label', 'data-scale-label');
  const paletteText = el(doc, 'span');
  const select = el(doc, 'select', 'data-scale-palette');
  for (const entry of PALETTES) {
    const option = el(doc, 'option', '', { value: entry.id });
    select.appendChild(option);
  }
  select.addEventListener('change', () =>
    live()?.onChange({ palette: select.value }),
  );
  paletteLabel.append(paletteText, select);
  const preview = el(doc, 'span', 'data-scale-preview');
  preview.setAttribute('aria-hidden', 'true');
  paletteRow.append(paletteLabel, preview);

  // The window: two handles over one track, and the numbers.
  const windowRow = el(doc, 'div', 'data-scale-window');
  const track = el(doc, 'div', 'data-scale-track');
  const floorRange = el(doc, 'input', 'data-scale-handle floor', {
    type: 'range',
    min: '0',
    max: String(SLIDER_STEPS),
    step: '1',
  });
  const ceilingRange = el(doc, 'input', 'data-scale-handle ceiling', {
    type: 'range',
    min: '0',
    max: String(SLIDER_STEPS),
    step: '1',
  });
  for (const [input, which] of [
    [floorRange, 'floor'],
    [ceilingRange, 'ceiling'],
  ])
    input.addEventListener('input', () => {
      const descriptor = live();
      if (!descriptor) return;
      const value = handleValue(descriptor, which, Number(input.value));
      if (value !== null) descriptor.onChange({ [which]: value });
    });
  track.append(floorRange, ceilingRange);
  const numbers = el(doc, 'div', 'data-scale-numbers');
  const floorInput = el(doc, 'input', 'data-scale-number', {
    type: 'number',
    step: 'any',
  });
  const ceilingInput = el(doc, 'input', 'data-scale-number', {
    type: 'number',
    step: 'any',
  });
  const units = el(doc, 'span', 'data-scale-units');
  for (const [input, which] of [
    [floorInput, 'floor'],
    [ceilingInput, 'ceiling'],
  ])
    input.addEventListener('change', () => {
      const text = input.value.trim();
      live()?.onChange({ [which]: text === '' ? null : Number(text) });
    });
  const dash = el(doc, 'span', 'data-scale-dash', { textContent: '–' });
  numbers.append(floorInput, dash, ceilingInput, units);
  windowRow.append(track, numbers);

  // Mapping, inversion, outside, reset.
  const buttons = el(doc, 'div', 'data-scale-line data-scale-buttons');
  const scaleButtons = new Map();
  for (const scale of SCALES) {
    const button = el(doc, 'button', 'data-toggle-chip data-scale-mapping', {
      type: 'button',
    });
    button.dataset.scale = scale;
    button.addEventListener('click', () => live()?.onChange({ scale }));
    scaleButtons.set(scale, button);
    buttons.appendChild(button);
  }
  const invert = el(doc, 'button', 'data-toggle-chip data-scale-invert', {
    type: 'button',
  });
  invert.addEventListener('click', () => {
    const descriptor = live();
    descriptor?.onChange({ invert: !descriptor.model.invert });
  });
  const outside = el(doc, 'button', 'data-toggle-chip data-scale-outside', {
    type: 'button',
  });
  outside.addEventListener('click', () => {
    const descriptor = live();
    descriptor?.onChange({
      outside: descriptor.model.outside === 'hide' ? 'clamp' : 'hide',
    });
  });
  const reset = el(doc, 'button', 'data-toggle-chip data-scale-reset', {
    type: 'button',
  });
  reset.addEventListener('click', () => live()?.onReset());
  buttons.append(invert, outside, reset);

  body.append(paletteRow, windowRow, buttons);
  root.append(toggle, body);
  return {
    root,
    toggle,
    paletteText,
    select,
    preview,
    floorRange,
    ceilingRange,
    floorInput,
    ceilingInput,
    units,
    scaleButtons,
    invert,
    outside,
    reset,
  };
}

/**
 * Render (or hide) a row's scale controls in its controls container.
 * @param {HTMLElement} container the row's `.data-toggle-controls`
 * @param {object|null} descriptor from scaleRowControl
 * @param {{live: () => object|null}} options `live`: the row's current
 *   descriptor, read by every handler (never a stale one)
 */
export function syncColourScaleWidget(container, descriptor, { live }) {
  let parts = container._scaleWidget || null;
  if (!descriptor) {
    if (parts) parts.root.hidden = true;
    return;
  }
  const doc = container.ownerDocument ?? globalThis.document;
  if (!parts) {
    parts = buildWidget(doc, live);
    container._scaleWidget = parts;
  }
  // Keep it just before the legend, after the chips.
  const firstLegend = container.querySelector('.data-toggle-legend-item');
  if (parts.root.parentNode !== container)
    container.insertBefore(
      parts.root,
      firstLegend || container._rowControlsInfo || null,
    );
  parts.root.hidden = false;
  const state = scaleControlState(descriptor);
  const { model, defaults } = descriptor;
  setIfChanged(
    parts.toggle,
    'textContent',
    state.isDefault ? t('SCALE') : t('SCALE •'),
  );
  setIfChanged(
    parts.toggle,
    'title',
    t('Palette, window (floor and ceiling), log or linear, invert'),
  );
  setIfChanged(parts.paletteText, 'textContent', t('Palette'));
  for (const option of parts.select.options) {
    const entry = PALETTES.find((p) => p.id === option.value);
    setIfChanged(option, 'textContent', t(entry.label));
  }
  if (!focused(parts.select))
    setIfChanged(parts.select, 'value', model.palette);
  parts.preview.style.background = paletteGradient(model.palette, defaults, {
    invert: model.invert,
  });
  const floorLabel = t('Floor');
  const ceilingLabel = t('Ceiling');
  for (const [node, label] of [
    [parts.floorRange, floorLabel],
    [parts.floorInput, floorLabel],
    [parts.ceilingRange, ceilingLabel],
    [parts.ceilingInput, ceilingLabel],
  ])
    if (node.getAttribute('aria-label') !== label)
      node.setAttribute('aria-label', label);
  const disabled = !state.window;
  for (const node of [
    parts.floorRange,
    parts.ceilingRange,
    parts.floorInput,
    parts.ceilingInput,
  ])
    setIfChanged(node, 'disabled', disabled);
  if (!focused(parts.floorRange))
    setIfChanged(parts.floorRange, 'value', String(state.floorHandle));
  if (!focused(parts.ceilingRange))
    setIfChanged(parts.ceilingRange, 'value', String(state.ceilingHandle));
  if (!focused(parts.floorInput))
    setIfChanged(parts.floorInput, 'value', state.floorText);
  if (!focused(parts.ceilingInput))
    setIfChanged(parts.ceilingInput, 'value', state.ceilingText);
  setIfChanged(parts.floorInput, 'placeholder', state.floorPlaceholder);
  setIfChanged(parts.ceilingInput, 'placeholder', state.ceilingPlaceholder);
  setIfChanged(parts.units, 'textContent', state.units);
  for (const [scale, button] of parts.scaleButtons) {
    const shown = state.scales.includes(scale);
    setIfChanged(button, 'hidden', !shown);
    setIfChanged(button, 'textContent', t(SCALE_WORDS[scale]));
    const active = model.scale === scale;
    button.classList.toggle('active', active);
    if (button.getAttribute('aria-pressed') !== String(active))
      button.setAttribute('aria-pressed', String(active));
  }
  setIfChanged(parts.invert, 'textContent', t('INVERT'));
  parts.invert.classList.toggle('active', model.invert);
  parts.invert.setAttribute('aria-pressed', String(model.invert));
  setIfChanged(parts.outside, 'textContent', t('HIDE OUTSIDE'));
  setIfChanged(
    parts.outside,
    'title',
    t(
      'Values outside the window are cleared, not painted the floor or ceiling colour',
    ),
  );
  const hide = model.outside === 'hide';
  parts.outside.classList.toggle('active', hide);
  parts.outside.setAttribute('aria-pressed', String(hide));
  setIfChanged(parts.reset, 'textContent', t('RESET'));
  setIfChanged(
    parts.reset,
    'title',
    t('Back to the layer’s own palette and automatic range'),
  );
  setIfChanged(parts.reset, 'disabled', state.isDefault);
}
