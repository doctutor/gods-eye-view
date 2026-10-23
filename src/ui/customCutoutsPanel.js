/**
 * Personal fork: the CUSTOM CUTOUTS panel in the right rail
 * (`#custom-cutouts-panel`), shown while the Custom cutouts layer is on.
 *
 * - The plate: BLACK or WHITE under the cut Google 3D tiles.
 * - ADD AT VIEW CENTRE lists the administrative areas under the middle of
 *   the view (Overpass is_in), most local first; ADD PARCEL AT VIEW CENTRE
 *   the property parcel there (Maryland only, MD iMAP); FIND does the same for a
 *   typed place through the search box's geocoder, falling back to the
 *   bundled boundary packs by name.
 * - Each cutout can be shown or hidden, renamed (its name field) and
 *   deleted; RESET LIST empties the list.
 *
 * Names come from OpenStreetMap, so everything is built as nodes with text,
 * never as HTML. `panelLines` is the panel's words for a layer view, pure,
 * so tests read them without a DOM.
 */
import { t, tn } from '../i18n/index.js';

const PANEL_ID = 'custom-cutouts-panel';

/** What the status line says for the layer's reason. */
export function statusText(view) {
  switch (view.reason) {
    case 'needs-3d':
      return t('Cutouts clip Google 3D: choose the Google 3D map');
    case 'no-webgl2':
      return t('This browser has no WebGL2: the tiles cannot be clipped');
    case 'empty':
      return t('Add a cutout: an area at the view centre, or by name');
    case 'none-visible':
      return t('Every cutout is hidden: the tiles are whole');
    case 'off':
      return t('Custom cutouts is off');
    default: {
      const shown = view.cutouts.filter((c) => c.visible).length;
      return tn(
        shown,
        '{count} cutout cut from Google 3D',
        '{count} cutouts cut from Google 3D',
        { count: shown },
      );
    }
  }
}

/** A cutout's level as its row tag says it (OSM's admin_level). */
export const levelTag = (level) =>
  Number.isInteger(level) ? t('L{level}', { level }) : '';

/** A cutout's or an area's tag: PARCEL for a Maryland parcel, else its level. */
export const cutoutTag = (entry) =>
  String(entry?.source || '').startsWith('mdp:')
    ? t('PARCEL')
    : levelTag(entry?.level);

/** The parcels button: enabled with the view centre in Maryland, else why not. */
export function parcelButtonState(view) {
  return view.parcelsHere
    ? {
        disabled: false,
        title: t('Cut out the property parcel under the view centre'),
      }
    : { disabled: true, title: t('Maryland parcels only') };
}

/** A cutout row's state, for its tag ('' when drawn). */
export function rowStatus(row) {
  if (row.status === 'loading') return t('LOADING');
  if (row.status === 'failed') return t('NOT FOUND');
  return '';
}

/** Why an area lookup came back empty. */
export function lookupText(answer) {
  if (answer.areas.length) {
    if (answer.from === 'packs')
      return t('Overpass did not answer: from the bundled boundaries');
    return '';
  }
  if (answer.reason === 'unconfigured')
    return t('No Overpass configured: add by name from the bundled boundaries');
  if (answer.kind === 'parcels') {
    if (answer.reason === 'outside') return t('Maryland parcels only');
    if (answer.reason === 'failed')
      return t('MD iMAP did not answer: try again');
    return t('No parcel at the view centre');
  }
  if (answer.reason === 'failed')
    return t('Overpass did not answer: try again, or add by name');
  return t('No administrative area found');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mount the panel's body into `container` (`#custom-cutouts-panel-body`).
 * @param {HTMLElement} container
 * @param {{layer: object}} options the Custom cutouts layer (its panel API)
 * @returns {{render(): void, destroy(): void}}
 */
export function createCustomCutoutsPanel(container, { layer }) {
  const panel = document.getElementById(PANEL_ID);
  const count = document.getElementById(`${PANEL_ID}-count`);
  let lookup = null;
  let areas = { areas: [], from: 'none', note: '' };
  let appeared = false;

  const root = el('div', 'cutouts');
  const status = el('div', 'cutouts-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const plate = el('div', 'cutouts-plate');
  plate.setAttribute('role', 'group');
  plate.setAttribute('aria-label', t('Plate under the cut tiles'));
  plate.append(el('span', 'cutouts-label', t('PLATE')));
  const plateButtons = {};
  for (const [key, label] of [
    ['black', t('BLACK', { context: 'plate colour' })],
    ['white', t('WHITE', { context: 'plate colour' })],
  ]) {
    const button = el('button', 'cutouts-chip', label);
    button.type = 'button';
    button.addEventListener('click', () => layer.setPlate(key));
    plateButtons[key] = button;
    plate.append(button);
  }

  const add = el('div', 'cutouts-add');
  const atView = el('button', 'panel-layer-toggle', t('ADD AT VIEW CENTRE'));
  atView.type = 'button';
  const parcelAt = el(
    'button',
    'panel-layer-toggle',
    t('ADD PARCEL AT VIEW CENTRE'),
  );
  parcelAt.type = 'button';
  const parcelNote = el('div', 'cutouts-note');
  const form = el('form', 'cutouts-find');
  const input = el('input');
  input.type = 'search';
  input.placeholder = t('Place name');
  input.setAttribute('aria-label', t('Find an area by name'));
  const find = el('button', '', t('FIND'));
  find.type = 'submit';
  form.append(input, find);
  const candidates = el('div', 'cutouts-areas');
  add.append(atView, parcelAt, parcelNote, form, candidates);

  const list = el('ul', 'cutouts-list');
  list.setAttribute('aria-label', t('Cutouts'));
  const reset = el('button', 'cutouts-reset', t('RESET LIST'));
  reset.type = 'button';
  reset.addEventListener('click', () => layer.reset());

  root.append(status, plate, add, list, reset);
  container.replaceChildren(root);

  async function runLookup(kind) {
    lookup?.abort();
    const controller = new AbortController();
    lookup = controller;
    areas = { areas: [], from: 'none', note: t('Looking up areas…') };
    renderAreas();
    try {
      const answer =
        kind === 'view'
          ? await layer.areasAtView({ signal: controller.signal })
          : kind === 'parcel'
            ? {
                kind: 'parcels',
                ...(await layer.parcelsAtView({ signal: controller.signal })),
              }
            : await layer.areasByName(input.value, {
                signal: controller.signal,
              });
      if (lookup !== controller) return;
      areas = { ...answer, note: lookupText(answer) };
    } catch (error) {
      if (error?.name === 'AbortError' || lookup !== controller) return;
      areas = { areas: [], from: 'none', note: t('The lookup failed') };
    }
    renderAreas();
  }
  atView.addEventListener('click', () => runLookup('view'));
  parcelAt.addEventListener('click', () => runLookup('parcel'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (input.value.trim()) runLookup('name');
  });

  function renderAreas() {
    const listed = new Set(layer.view().cutouts.map((c) => c.source));
    const nodes = [];
    if (areas.note) nodes.push(el('div', 'cutouts-note', areas.note));
    for (const area of areas.areas) {
      const row = el('div', 'cutouts-area');
      row.append(
        el('span', 'cutouts-level', cutoutTag(area)),
        el('span', 'cutouts-name', area.name),
      );
      const button = el(
        'button',
        'cutouts-chip',
        listed.has(area.source) ? t('ADDED') : t('ADD'),
      );
      button.type = 'button';
      button.disabled = listed.has(area.source);
      button.addEventListener('click', () => {
        layer.add(area);
        renderAreas();
      });
      row.append(button);
      nodes.push(row);
    }
    candidates.replaceChildren(...nodes);
  }

  function renderList(view) {
    const rows = view.cutouts.map((cutout) => {
      const item = el('li', 'cutouts-row');
      item.dataset.source = cutout.source;
      item.classList.toggle('is-hidden', !cutout.visible);
      const eye = el('button', 'cutouts-eye', cutout.visible ? '◉' : '○');
      eye.type = 'button';
      eye.setAttribute('aria-pressed', String(cutout.visible));
      eye.title = cutout.visible
        ? t('Hide this cutout')
        : t('Show this cutout');
      eye.setAttribute('aria-label', eye.title);
      eye.addEventListener('click', () =>
        layer.setVisible(cutout.source, !cutout.visible),
      );
      const name = el('input', 'cutouts-name-input');
      name.value = cutout.name;
      name.setAttribute('aria-label', t('Cutout name'));
      const commit = () => {
        if (name.value.trim() && name.value !== cutout.name)
          layer.rename(cutout.source, name.value);
        else name.value = cutout.name;
      };
      name.addEventListener('change', commit);
      name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') name.blur();
        if (event.key === 'Escape') {
          name.value = cutout.name;
          name.blur();
        }
      });
      const state = rowStatus(cutout);
      const tag = el('span', 'cutouts-level', state || cutoutTag(cutout));
      if (cutout.status === 'failed') {
        tag.title = t('Retry');
        tag.classList.add('is-failed');
        tag.addEventListener('click', () => layer.retry(cutout.source));
      }
      const remove = el('button', 'cutouts-delete', '×');
      remove.type = 'button';
      remove.title = t('Delete this cutout');
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => layer.remove(cutout.source));
      item.append(eye, name, tag, remove);
      return item;
    });
    // Keep a name being typed: rebuild only when the list itself changed.
    if (
      container.contains(document.activeElement) &&
      document.activeElement?.classList?.contains('cutouts-name-input')
    )
      return;
    list.replaceChildren(...rows);
  }

  function render() {
    const view = layer.view();
    if (panel) panel.hidden = !view.enabled;
    if (count)
      count.textContent = view.enabled ? String(view.cutouts.length) : '';
    status.textContent = statusText(view);
    for (const [key, button] of Object.entries(plateButtons)) {
      button.classList.toggle('active', view.plate === key);
      button.setAttribute('aria-pressed', String(view.plate === key));
    }
    reset.disabled = !view.cutouts.length;
    const parcels = parcelButtonState(view);
    parcelAt.disabled = parcels.disabled;
    parcelAt.title = parcels.title;
    parcelNote.textContent = parcels.disabled ? parcels.title : '';
    parcelNote.hidden = !parcels.disabled;
    renderList(view);
    renderAreas();
    // First appearance opens it, unless a collapse choice was restored.
    if (view.enabled && panel && !appeared) {
      appeared = true;
      const preference = panel.dataset?.collapsedPreference;
      if (
        panel.classList.contains('collapsed') &&
        (preference === undefined || preference === 'default')
      )
        panel.querySelector(`[data-collapse-target="${PANEL_ID}"]`)?.click();
    }
  }

  const off = layer.onChange(render);
  render();
  return {
    render,
    destroy() {
      off();
      lookup?.abort();
      container.replaceChildren();
    },
  };
}
