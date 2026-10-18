// Personal fork: the MAP SOURCE tray's second row. Upstream's five chips
// (mapStackChips.js) stay exactly as they are; every other controller stack
// goes into one compact grouped <select>, so fourteen keyless styles do not
// turn the tray into three rows of buttons. Like the chips it is a control
// surface only: a choice calls the same selection path, and the shown value is
// re-synced from controller state, never from the choice.

import { t } from './i18n/index.js';
import { PRESENTED_MAP_STACK_IDS } from './mapStackChips.js';
import { KEYLESS_BASEMAP_GROUPS } from './maps/keylessBasemapCatalog.js';

export const MAP_STACK_MORE_CLASS = 'map-stack-more-select';
export const MAP_STACK_MORE_NOTE_CLASS = 'map-stack-more-note';
/** The option shown while one of the five chips is the active source. */
export const MAP_STACK_MORE_PLACEHOLDER = '';

const handles = new WeakMap();

/** The translated group headings; product groups carry their own label. */
const GROUP_LABELS = {
  blank: () => t('Blank', { context: 'map style' }),
  light: () => t('Light', { context: 'map style' }),
  dark: () => t('Dark', { context: 'map style' }),
  terrain: () => t('Terrain', { context: 'map style' }),
};

function groupLabel(group) {
  return group.label ?? GROUP_LABELS[group.id]?.() ?? group.id;
}

/**
 * One option of the picker.
 * @param {object} stack `MapStackController.getStacks()` entry.
 * @param {string|null} activeId
 */
export function mapStackMoreOption(stack, activeId) {
  const available = stack?.available !== false;
  const label = String(stack?.label ?? stack?.id ?? '');
  const hint = available
    ? ''
    : String(
        stack?.unavailableReason || t('{label} is unavailable', { label }),
      );
  return {
    id: String(stack?.id ?? ''),
    label,
    available,
    active: !!stack?.id && stack.id === activeId,
    note: stack?.note ? t(stack.note) : '',
    title: available ? label : hint,
  };
}

/**
 * The picker's groups: every stack outside the chip row, in catalog group
 * order, with stacks of an unknown group last under "Other".
 * @param {Array<object>} stacks `MapStackController.getStacks()` output.
 * @param {string|null} activeId
 * @returns {Array<{id: string, label: string, options: Array<object>}>}
 */
export function mapStackMoreGroups(stacks, activeId) {
  const chips = new Set(PRESENTED_MAP_STACK_IDS);
  const extra = (Array.isArray(stacks) ? stacks : []).filter(
    (stack) => stack?.id && !chips.has(stack.id),
  );
  const groups = KEYLESS_BASEMAP_GROUPS.map((group) => ({
    id: group.id,
    label: groupLabel(group),
    options: [],
  }));
  const other = { id: 'other', label: t('Other'), options: [] };
  for (const stack of extra) {
    const group = groups.find((entry) => entry.id === stack.group) || other;
    group.options.push(mapStackMoreOption(stack, activeId));
  }
  return [...groups, other].filter((group) => group.options.length);
}

/**
 * Render the picker into `container`, replacing any previous one. The
 * container is hidden when the controller has nothing beyond the chips.
 * @param {HTMLElement} container
 * @param {Array<object>} stacks
 * @param {object} [options]
 * @param {string|null} [options.activeId]
 * @param {(stackId: string) => void} [options.onSelect]
 * @param {Document} [options.doc]
 * @param {(element: HTMLElement, type: string, listener: Function) => void} [options.bind]
 * @returns {{ select: HTMLElement, note: HTMLElement, groups: Array<object>, sync: (activeId: string|null) => void } | null}
 */
export function renderMapStackMore(
  container,
  stacks,
  {
    activeId = null,
    onSelect = null,
    doc,
    bind = (element, type, listener) =>
      element.addEventListener(type, listener),
  } = {},
) {
  if (!container) return null;
  const ownerDoc = doc || container.ownerDocument || globalThis.document;
  if (!ownerDoc?.createElement) return null;

  container.innerHTML = '';
  const groups = mapStackMoreGroups(stacks, activeId);
  container.hidden = groups.length === 0;

  const select = ownerDoc.createElement('select');
  select.className = `pp-select ${MAP_STACK_MORE_CLASS}`;
  select.setAttribute('aria-label', t('More map styles'));
  select.title = t('More map styles');

  const placeholder = ownerDoc.createElement('option');
  placeholder.value = MAP_STACK_MORE_PLACEHOLDER;
  placeholder.textContent = t('More styles…');
  select.appendChild(placeholder);

  const byId = new Map();
  for (const group of groups) {
    const optgroup = ownerDoc.createElement('optgroup');
    optgroup.label = group.label;
    for (const model of group.options) {
      const option = ownerDoc.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      option.title = model.title;
      option.disabled = !model.available;
      optgroup.appendChild(option);
      byId.set(model.id, model);
    }
    select.appendChild(optgroup);
  }

  const note = ownerDoc.createElement('span');
  note.className = MAP_STACK_MORE_NOTE_CLASS;

  let current = activeId;
  const sync = (id) => {
    current = id;
    const model = byId.get(id) || null;
    select.value = model ? model.id : MAP_STACK_MORE_PLACEHOLDER;
    select.classList?.toggle('active', Boolean(model));
    note.textContent = model?.note || '';
    note.hidden = !model?.note;
  };
  sync(activeId);

  bind(select, 'change', () => {
    const id = select.value;
    const model = byId.get(id);
    // The placeholder, or a disabled option a browser let through: the
    // shown value goes back to the truly active source.
    if (!model || !model.available) {
      sync(current);
      return;
    }
    onSelect?.(id);
  });

  container.appendChild(select);
  container.appendChild(note);
  const handle = { select, note, groups, sync };
  handles.set(container, handle);
  return handle;
}

/**
 * Re-point the picker at controller state. The placeholder shows while one
 * of the chips is active; otherwise the active style and its note.
 * @param {HTMLElement} container
 * @param {string|null} activeId
 */
export function syncMapStackMore(container, activeId) {
  handles.get(container)?.sync(activeId);
}
