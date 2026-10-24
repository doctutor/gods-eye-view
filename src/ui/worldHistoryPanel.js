/**
 * Personal fork: the WORLD HISTORY panel in the right rail
 * (`#world-history-panel`), shown while the World history layer is on.
 *
 * - YEAR: a slider and a typed year (2500 BC to 2025 AD; no year 0, so
 *   1 BC is followed by 1 AD), with steps of one year either way.
 * - VIEW: Cottereau's polities (and, on request, his place-only matches)
 *   or every Cliopatria polity alive that year.
 * - COMPARE: a list of polities picked by name (several at once), each in
 *   its own colour at its largest or as at the year, shown or hidden,
 *   deleted, or all cleared; one opacity for their fills.
 * - The polity clicked on the map, with its Wikipedia link.
 *
 * Names come from the data, so everything is built as nodes with text,
 * never as HTML. The words for each state are pure functions, so tests
 * read them without a DOM.
 */
import { t, tn } from '../i18n/index.js';
import {
  CLIOPATRIA_LAST_YEAR,
  CLIOPATRIA_URL,
  LIST_PALETTE,
  MAX_LIST_ENTRIES,
  SLIDER_MAX,
  SLIDER_MIN,
  WORLD_HISTORY_LAST_YEAR,
  clampYear,
  parseYear,
  rankNames,
  rgba,
  sliderFromYear,
  stepYear,
  yearFromSlider,
} from '../data/worldHistory.js';
import {
  areaText,
  spanText,
  wikipediaUrl,
  yearText,
} from '../layers/worldHistory/presentation.js';

const PANEL_ID = 'world-history-panel';
/** The picker shows at most this many names at once. */
export const PICKER_ROWS = 200;

/** What the status line says. */
export function statusText(view) {
  if (!view.enabled) return t('World history is off');
  if (view.status === 'not-built')
    return t('Run npm run world-history:build for the World history layer');
  if (view.status === 'failed')
    return t('The year could not be loaded: {error}', { error: view.error });
  if (view.status !== 'ready')
    return t('Loading {year}…', { year: yearText(view.year) });
  return view.mode === 'all'
    ? tn(
        view.count,
        '{count} Cliopatria polity in {year}',
        '{count} Cliopatria polities in {year}',
        {
          count: view.count,
          year: yearText(view.year),
        },
      )
    : tn(
        view.count,
        '{count} polity Cottereau shows in {year}',
        '{count} polities Cottereau shows in {year}',
        {
          count: view.count,
          year: yearText(view.year),
        },
      );
}

/** The note under the year: 2025 reads Cliopatria's 2024. */
export const yearNote = (view) =>
  view.year > CLIOPATRIA_LAST_YEAR
    ? t('Cliopatria ends in {last}: {year} shows {last}', {
        last: CLIOPATRIA_LAST_YEAR,
        year: view.year,
      })
    : '';

/** A list row's tag: loading, failed, or absent in the year. */
export function entryTag(entry, year) {
  if (entry.state === 'loading') return t('LOADING');
  if (entry.state === 'failed') return t('FAILED');
  if (entry.state === 'absent')
    return t('NOT IN {year}', {
      year: yearText(Math.min(year, CLIOPATRIA_LAST_YEAR)),
    });
  return '';
}

/**
 * The picker's names for a query: all (largest first) when empty, else the
 * best matches first (rankNames), at most `limit`.
 */
export const filterNames = (names, query, limit = PICKER_ROWS) =>
  rankNames(names, query, { limit });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/**
 * Mount the panel's body into `container` (`#world-history-panel-body`).
 * @param {HTMLElement} container
 * @param {{layer: object}} options the World history layer (its panel API)
 * @returns {{render(): void, destroy(): void}}
 */
export function createWorldHistoryPanel(container, { layer }) {
  const panel = document.getElementById(PANEL_ID);
  const count = document.getElementById(`${PANEL_ID}-count`);
  let appeared = false;
  let names = [];
  let namesState = 'idle';
  const checked = new Set();

  const root = el('div', 'world-history');
  const status = el('div', 'world-history-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  // YEAR
  const yearBox = el('div', 'world-history-year');
  yearBox.append(el('span', 'world-history-label', t('YEAR')));
  const back = button('world-history-chip', '◀', () =>
    layer.setYear(stepYear(layer.view().year, -1)),
  );
  back.title = t('One year back');
  back.setAttribute('aria-label', back.title);
  const slider = el('input', 'world-history-slider');
  slider.type = 'range';
  slider.min = String(SLIDER_MIN);
  slider.max = String(SLIDER_MAX);
  slider.step = '1';
  slider.setAttribute('aria-label', t('Year'));
  slider.addEventListener('input', () =>
    layer.setYear(yearFromSlider(Number(slider.value))),
  );
  const forward = button('world-history-chip', '▶', () =>
    layer.setYear(stepYear(layer.view().year, 1)),
  );
  forward.title = t('One year on');
  forward.setAttribute('aria-label', forward.title);
  const typed = el('input', 'world-history-year-input');
  typed.type = 'text';
  typed.inputMode = 'text';
  typed.setAttribute('aria-label', t('Type a year'));
  typed.placeholder = t('500 BC, -500, 1 AD');
  const typedNote = el('div', 'world-history-note');
  const commitYear = () => {
    const year = parseYear(typed.value);
    if (year === null) {
      typedNote.textContent = t('Type a year like 500 BC, -500 or 1 AD');
      return;
    }
    typedNote.textContent = '';
    layer.setYear(clampYear(year));
  };
  typed.addEventListener('change', commitYear);
  typed.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commitYear();
  });
  const yearRow = el('div', 'world-history-row');
  yearRow.append(back, slider, forward, typed);
  yearBox.append(yearRow, typedNote);

  // VIEW
  const modeBox = el('div', 'world-history-mode');
  modeBox.setAttribute('role', 'group');
  modeBox.setAttribute('aria-label', t('Which polities the year shows'));
  modeBox.append(el('span', 'world-history-label', t('VIEW')));
  const modeButtons = {};
  for (const [key, label] of [
    ['cottereau', t('COTTEREAU')],
    ['all', t('ALL CLIOPATRIA')],
  ]) {
    const chip = button('world-history-chip', label, () => layer.setMode(key));
    modeButtons[key] = chip;
    modeBox.append(chip);
  }
  const placesLabel = el('label', 'world-history-check');
  const places = el('input');
  places.type = 'checkbox';
  places.addEventListener('change', () => layer.setPlaces(places.checked));
  placesLabel.append(
    places,
    document.createTextNode(` ${t('Include place-only matches')}`),
  );

  // COMPARE
  const compare = el('div', 'world-history-compare');
  compare.append(el('span', 'world-history-label', t('COMPARE')));
  const query = el('input', 'world-history-query');
  query.type = 'search';
  query.placeholder = t('Polity name');
  query.setAttribute('aria-label', t('Find polities by name'));
  const picker = el('div', 'world-history-picker');
  picker.setAttribute('role', 'listbox');
  picker.setAttribute('aria-multiselectable', 'true');
  const addChecked = button('panel-layer-toggle', '', () => {
    for (const name of checked) layer.add(name);
    checked.clear();
    renderPicker();
  });
  query.addEventListener('input', () => renderPicker());
  query.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const [first] = filterNames(names, query.value, 1);
    if (first) layer.add(first.name);
  });
  query.addEventListener('focus', () => loadNames());
  const opacityRow = el('div', 'world-history-row');
  const opacity = el('input', 'world-history-slider');
  opacity.type = 'range';
  opacity.min = '0';
  opacity.max = '100';
  opacity.step = '1';
  opacity.setAttribute('aria-label', t('Opacity of the compared fills'));
  opacity.addEventListener('input', () =>
    layer.setOpacity(Number(opacity.value) / 100),
  );
  const opacityValue = el('span', 'world-history-value');
  opacityRow.append(
    el('span', 'world-history-label', t('OPACITY')),
    opacity,
    opacityValue,
  );
  const list = el('ul', 'world-history-list');
  list.setAttribute('aria-label', t('Compared polities'));
  const clear = button('world-history-reset', t('CLEAR'), () => layer.clear());
  compare.append(query, picker, addChecked, opacityRow, list, clear);

  // The clicked polity
  const selection = el('div', 'world-history-selected');

  const credit = el('div', 'world-history-credit');
  const creditLink = el('a', '', 'Cliopatria (Seshat Global History Databank)');
  creditLink.href = CLIOPATRIA_URL;
  creditLink.target = '_blank';
  creditLink.rel = 'noopener';
  const licence = el('a', '', 'CC BY 4.0');
  licence.href = 'https://creativecommons.org/licenses/by/4.0/';
  licence.target = '_blank';
  licence.rel = 'noopener';
  credit.append(
    document.createTextNode(`${t('Shapes')}: `),
    creditLink,
    document.createTextNode(', '),
    licence,
    document.createTextNode(
      `. ${t('Which polities and names: after Cottereau’s “History of the World: Every Year”.')}`,
    ),
  );

  root.append(
    status,
    yearBox,
    modeBox,
    placesLabel,
    compare,
    selection,
    credit,
  );
  container.replaceChildren(root);

  function loadNames() {
    if (namesState === 'loading' || namesState === 'ready') return;
    namesState = 'loading';
    renderPicker();
    Promise.resolve(layer.names())
      .then((all) => {
        names = all || [];
        namesState = 'ready';
        renderPicker();
      })
      .catch(() => {
        namesState = 'failed';
        renderPicker();
      });
  }

  function renderPicker() {
    const view = layer.view();
    const listed = new Set(view.list.map((entry) => entry.name));
    const full = view.list.length >= MAX_LIST_ENTRIES;
    const rows = [];
    if (namesState === 'loading')
      rows.push(el('div', 'world-history-note', t('Loading the names…')));
    else if (namesState === 'failed')
      rows.push(
        el('div', 'world-history-note', t('The names could not be loaded')),
      );
    else if (namesState === 'ready')
      for (const entry of filterNames(names, query.value)) {
        const row = el('label', 'world-history-name');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = listed.has(entry.name) || checked.has(entry.name);
        box.disabled =
          listed.has(entry.name) || (full && !checked.has(entry.name));
        box.addEventListener('change', () => {
          if (box.checked) checked.add(entry.name);
          else checked.delete(entry.name);
          renderPicker();
        });
        row.append(
          box,
          el('span', 'world-history-name-text', entry.name),
          el('span', 'world-history-years', spanText(entry.from, entry.to)),
        );
        if (entry.cottereau) row.classList.add('is-cottereau');
        rows.push(row);
      }
    picker.replaceChildren(...rows);
    picker.hidden = namesState === 'idle';
    addChecked.textContent = tn(
      checked.size,
      'ADD {count} SELECTED',
      'ADD {count} SELECTED',
      {
        count: checked.size,
      },
    );
    addChecked.disabled = !checked.size;
  }

  function renderList(view) {
    const rows = view.list.map((entry) => {
      const item = el('li', 'world-history-row-entry');
      item.classList.toggle('is-hidden', !entry.visible);
      const swatch = el('span', 'world-history-swatch');
      swatch.style.background = rgba(
        LIST_PALETTE[entry.color % LIST_PALETTE.length],
        1,
      );
      const eye = button('world-history-eye', entry.visible ? '◉' : '○', () =>
        layer.setVisible(entry.name, !entry.visible),
      );
      eye.setAttribute('aria-pressed', String(entry.visible));
      eye.title = entry.visible ? t('Hide this polity') : t('Show this polity');
      eye.setAttribute('aria-label', eye.title);
      const name = el('span', 'world-history-entry-name', entry.name);
      name.title =
        entry.from !== undefined
          ? `${entry.name}, ${spanText(entry.from, entry.to)}`
          : entry.name;
      const extent = button(
        'world-history-chip',
        entry.extent === 'year' ? t('AT YEAR') : t('MAX'),
        () =>
          layer.setExtent(entry.name, entry.extent === 'year' ? 'max' : 'year'),
      );
      extent.title =
        entry.extent === 'year'
          ? t('As at the slider year: click for its largest extent')
          : t('Its largest extent: click for the slider year');
      const tag = el('span', 'world-history-tag', entryTag(entry, view.year));
      const remove = button('world-history-delete', '×', () =>
        layer.remove(entry.name),
      );
      remove.title = t('Remove from the list');
      remove.setAttribute('aria-label', remove.title);
      item.append(swatch, eye, name, extent, tag, remove);
      return item;
    });
    list.replaceChildren(...rows);
    clear.disabled = !view.list.length;
  }

  function renderSelection(view) {
    const chosen = view.selected;
    selection.hidden = !chosen;
    if (!chosen) return selection.replaceChildren();
    const nodes = [
      el('div', 'world-history-selected-title', chosen.title),
      el('div', 'world-history-note', spanText(chosen.from, chosen.to)),
    ];
    if (chosen.title !== chosen.name)
      nodes.push(
        el(
          'div',
          'world-history-note',
          t('Cliopatria: {name}', { name: chosen.name }),
        ),
      );
    if (chosen.area)
      nodes.push(el('div', 'world-history-note', areaText(chosen.area)));
    const actions = el('div', 'world-history-row');
    if (chosen.wikipedia) {
      const link = el(
        'a',
        'world-history-link',
        t('Wikipedia: {title}', { title: chosen.wikipedia }),
      );
      link.href = wikipediaUrl(chosen.wikipedia);
      link.target = '_blank';
      link.rel = 'noopener';
      actions.append(link);
    }
    actions.append(
      button('world-history-chip', t('COMPARE'), () => layer.add(chosen.name)),
      button('world-history-delete', '×', () => layer.closeCard()),
    );
    nodes.push(actions);
    selection.replaceChildren(...nodes);
  }

  function render() {
    const view = layer.view();
    if (panel) panel.hidden = !view.enabled;
    if (count) count.textContent = view.enabled ? yearText(view.year) : '';
    status.textContent = statusText(view);
    const position = String(sliderFromYear(view.year));
    if (slider.value !== position) slider.value = position;
    if (document.activeElement !== typed) typed.value = yearText(view.year);
    const note = yearNote(view);
    if (!typedNote.textContent || typedNote.dataset.kind === 'clio') {
      typedNote.textContent = note;
      typedNote.dataset.kind = note ? 'clio' : '';
    }
    back.disabled = view.year <= SLIDER_MIN;
    forward.disabled = view.year >= WORLD_HISTORY_LAST_YEAR;
    for (const [key, chip] of Object.entries(modeButtons)) {
      chip.classList.toggle('active', view.mode === key);
      chip.setAttribute('aria-pressed', String(view.mode === key));
    }
    places.checked = view.places;
    places.disabled = view.mode !== 'cottereau';
    const percent = String(Math.round(view.opacity * 100));
    if (opacity.value !== percent) opacity.value = percent;
    opacityValue.textContent = `${percent}%`;
    renderList(view);
    renderSelection(view);
    if (namesState !== 'idle') renderPicker();
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
  renderPicker();
  return {
    render,
    destroy() {
      off();
      container.replaceChildren();
    },
  };
}
