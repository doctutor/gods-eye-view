/**
 * Personal fork: the TREEMAP window's address bar (docs/TREEMAP-PLAN.md):
 * the address as text, editable (Enter applies it; a bad one shows the
 * shared parser's or the catalogue's message; `*` is shown as `×` and `×`
 * is read as `*`); a quantity drop-down (quantity › unit › variable,
 * filtered as you type, a variable not built shown dimmed with its reason);
 * a sequence drop-down in the catalogue's order with each one's title and
 * "reveals" line, also filtered as you type; and the address's groupings as
 * pills: remove, reorder (drag, or the arrow keys on a pill), add from the
 * cuts the variable takes, and `/` or `×` between two. Text and pills are
 * the one address in the store, so they stay in step. The edits are pure
 * functions of the address (exported for the tests).
 */
import { t, msg } from '../i18n/index.js';
import {
  formatTreemapAddress,
  parseTreemapAddress,
} from '../data/treemapAddress.js';
import {
  TREEMAP_NEEDS,
  TREEMAP_QUANTITIES,
  TREEMAP_UNITS,
  TREEMAP_VARIABLES,
  checkTreemapAddress,
  treemapGrouping,
  treemapVariable,
} from '../data/treemapCatalog.js';

const NOT_BUILT = msg('Not built yet');

/** A grouping's name in the window. */
export const groupingName = (id) => {
  const label = treemapGrouping(id)?.label;
  return label ? t(label) : id;
};

/** A variable's name in the window. */
export const variableName = (id) => {
  const label = treemapVariable(id)?.label;
  return label ? t(label) : id;
};

/** The address as the bar shows it: `*` as `×`. */
export const addressText = (address) =>
  String(address ?? '').replace(/\*/g, ' × ');

/**
 * Text typed into the bar read as an address: {ok: true, address} (the
 * parser's own writing of it) or {ok: false, message} (translated). The
 * catalogue checks the variable and its groupings; a variable it does not
 * know but the service's catalogue does still reads.
 */
export function readAddressText(text, catalog = null) {
  const parsed = parseTreemapAddress(String(text ?? ''));
  if (!parsed.ok) return { ok: false, message: t(parsed.error, parsed.values) };
  const address = formatTreemapAddress(parsed);
  const served = catalog?.variables?.find((v) => v.id === parsed.variable);
  if (served?.groupings?.length) {
    // The service's catalogue says what it takes.
    const missing = parsed.groupings.find(
      (id) => !served.groupings.includes(id),
    );
    if (missing)
      return {
        ok: false,
        message: t('{variable} cannot be cut by {grouping}', {
          variable: parsed.variable,
          grouping: missing,
        }),
      };
    return { ok: true, address };
  }
  const checked = checkTreemapAddress(address);
  if (!checked.ok)
    return { ok: false, message: t(checked.error, checked.values) };
  return { ok: true, address };
}

/** An address rebuilt from its parts; the old one if they would not read. */
function rebuilt(address, variable, groupings, joins) {
  try {
    return formatTreemapAddress({ variable, groupings, joins });
  } catch {
    return address;
  }
}

/** The address with its grouping at `index` taken out (never the last). */
export function removeGrouping(address, index) {
  const parsed = parseTreemapAddress(address);
  if (!parsed.ok || !parsed.groupings[index] || parsed.groupings.length < 2)
    return address;
  const groupings = parsed.groupings.filter((_, k) => k !== index);
  // The join that went with the removed grouping goes too: the one before
  // it, or, for the first, the one after it.
  const joins = [...parsed.joins];
  joins.splice(Math.max(0, index - 1), 1);
  return rebuilt(address, parsed.variable, groupings, joins);
}

/** The address with the grouping at `from` moved to `to` (joins stay put). */
export function moveGrouping(address, from, to) {
  const parsed = parseTreemapAddress(address);
  if (!parsed.ok) return address;
  const list = [...parsed.groupings];
  if (!list[from] || to < 0 || to >= list.length || from === to) return address;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return rebuilt(address, parsed.variable, list, parsed.joins);
}

/** The address with `groupingId` added last, after `join`, if not there. */
export function addGrouping(address, groupingId, join = '/') {
  const parsed = parseTreemapAddress(address);
  if (!parsed.ok || parsed.groupings.includes(groupingId)) return address;
  return rebuilt(
    address,
    parsed.variable,
    [...parsed.groupings, groupingId],
    [...parsed.joins, join === '*' ? '*' : '/'],
  );
}

/** The join before the grouping at `index` (1 or more) flipped, `/` ⇄ `*`. */
export function toggleJoin(address, index) {
  const parsed = parseTreemapAddress(address);
  if (!parsed.ok || index < 1 || !parsed.groupings[index]) return address;
  const joins = parsed.joins.map((join, k) =>
    k === index - 1 ? (join === '*' ? '/' : '*') : join,
  );
  return rebuilt(address, parsed.variable, parsed.groupings, joins);
}

/** The groupings the variable takes (per `catalog`) not yet in the address. */
export function addableGroupings(address, catalog) {
  const parsed = parseTreemapAddress(address);
  if (!parsed.ok) return [];
  const variable = catalog?.variables?.find((v) => v.id === parsed.variable);
  const takes = variable?.groupings?.length
    ? variable.groupings
    : treemapVariable(parsed.variable)?.groupings || [];
  return takes.filter((id) => !parsed.groupings.includes(id));
}

const contains = (needle) => (text) =>
  String(text ?? '')
    .toLowerCase()
    .includes(needle);

/**
 * The quantity drop-down's entries: the catalogue's variables (and any the
 * service's catalogue adds), grouped quantity › unit, filtered by `filter`
 * against their quantity, unit, name and id; each {id, name, available,
 * why}. A variable the service's catalogue does not list, or lists as not
 * available, is not built: dimmed, with its reason.
 * @returns {{quantity: string, unit: string, variables: object[]}[]}
 */
export function variableEntries(catalog, filter = '') {
  const served = new Map((catalog?.variables || []).map((v) => [v.id, v]));
  const needle = String(filter).trim().toLowerCase();
  const quantityLabel = (id) =>
    TREEMAP_QUANTITIES.find((quantity) => quantity.id === id)?.label || id;
  const unitLabel = (id) => {
    const unit = TREEMAP_UNITS[id];
    return unit?.symbol || (unit?.name ? t(unit.name) : id);
  };
  const row = (id, quantity, unit, name) => {
    const known = served.get(id);
    const available = Boolean(known) && known.available !== false;
    return {
      id,
      quantity,
      unit,
      name,
      available,
      why: available ? '' : known?.why ? t(known.why) : t(NOT_BUILT),
    };
  };
  const rows = TREEMAP_VARIABLES.map((variable) =>
    row(
      variable.id,
      t(quantityLabel(variable.quantity)),
      unitLabel(variable.unit),
      t(variable.label),
    ),
  );
  for (const extra of catalog?.variables || [])
    if (!treemapVariable(extra.id)) {
      const [unit, name] = extra.id.split('/');
      const quantity = TREEMAP_UNITS[unit]?.quantity;
      rows.push(
        row(
          extra.id,
          quantity ? t(quantityLabel(quantity)) : unit,
          unitLabel(unit),
          name,
        ),
      );
    }
  const kept = needle
    ? rows.filter((r) =>
        [r.quantity, r.unit, r.name, r.id].some(contains(needle)),
      )
    : rows;
  const groups = [];
  for (const r of kept) {
    let group = groups.find(
      (g) => g.quantity === r.quantity && g.unit === r.unit,
    );
    if (!group)
      groups.push(
        (group = { quantity: r.quantity, unit: r.unit, variables: [] }),
      );
    group.variables.push(r);
  }
  return groups;
}

/** The cuts of an address as words: "Continent / Country × Land cover". */
export function cutsText(address) {
  const parsed = parseTreemapAddress(address);
  if (!parsed.ok) return address;
  return parsed.groupings
    .map(
      (id, k) =>
        `${k ? (parsed.joins[k - 1] === '*' ? ' × ' : ' / ') : ''}${groupingName(id)}`,
    )
    .join('');
}

/**
 * The sequence drop-down's entries for a variable, filtered by `filter`
 * against their title, what they reveal and their cuts; each {address,
 * title, reveals, cuts, why} (`why` set: disabled, it waits on a table or
 * on its first cut; a deeper cut not built only stops the view there).
 */
export function sequenceEntries(variableId, catalog, filter = '') {
  const variable = treemapVariable(variableId);
  const served = catalog?.variables?.find((v) => v.id === variableId);
  const supported = new Set(served?.groupings || []);
  const needle = String(filter).trim().toLowerCase();
  return (variable?.sequences || [])
    .map((sequence) => {
      const parsed = parseTreemapAddress(sequence.address);
      // The first grouping, and any overlaid with `*`, must be served; a
      // deeper `/` cut not built only stops the view there.
      const missing =
        served && parsed.ok
          ? parsed.groupings.find(
              (id, i) =>
                (i === 0 || parsed.joins[i - 1] === '*') && !supported.has(id),
            )
          : null;
      const why = sequence.needs
        ? t('Waits on {cuts}', {
            cuts: TREEMAP_NEEDS[sequence.needs]
              ? t(TREEMAP_NEEDS[sequence.needs])
              : sequence.needs,
          })
        : missing
          ? t('Waits on {cuts}', { cuts: groupingName(missing) })
          : '';
      return {
        address: sequence.address,
        title: sequence.title ? t(sequence.title) : '',
        reveals: sequence.reveals ? t(sequence.reveals) : '',
        cuts: cutsText(sequence.address),
        why,
      };
    })
    .filter(
      (entry) =>
        !needle ||
        [entry.title, entry.reveals, entry.cuts, entry.address].some(
          contains(needle),
        ),
    );
}

function el(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{container: Element, documentRef: Document, store: object,
 *   catalog: () => object|null}} options
 */
export function createAddressBar({ container, documentRef, store, catalog }) {
  const removers = [];
  let open = null; // 'variable' | 'sequence' | 'add' | null
  let filter = '';
  let dragFrom = null;
  // The text field: what was typed while it is being edited, and why it
  // did not read.
  let draft = null;
  let problem = '';

  const set = (address) => {
    if (address !== store.get().address) store.setAddress(address);
  };

  function closeMenus() {
    if (!open) return;
    open = null;
    filter = '';
    render();
  }
  const onDocument = (event) => {
    if (open && !container.contains(event.target)) closeMenus();
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && open) closeMenus();
  };
  documentRef.addEventListener('pointerdown', onDocument, true);
  documentRef.addEventListener('keydown', onKey);
  removers.push(() => {
    documentRef.removeEventListener('pointerdown', onDocument, true);
    documentRef.removeEventListener('keydown', onKey);
  });

  /** A menu with its filter field on top; `listOf()` redraws as typed. */
  function filteredMenu(label, placeholder, listOf) {
    const menu = el(documentRef, 'div', 'treemap-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label);
    const input = el(documentRef, 'input', 'treemap-filter');
    input.type = 'search';
    input.placeholder = placeholder;
    input.value = filter;
    input.setAttribute('aria-label', placeholder);
    input.addEventListener('input', () => {
      filter = input.value;
      menu.querySelector('.treemap-menu-list')?.replaceWith(listOf());
    });
    input.addEventListener('keydown', (event) => {
      // Enter takes the first item that can be taken.
      if (event.key !== 'Enter') return;
      event.preventDefault();
      menu.querySelector('.treemap-menu-item:not(:disabled)')?.click();
    });
    menu.append(input, listOf());
    queueMicrotask?.(() => input.focus?.());
    return menu;
  }

  function variableMenu(parsed) {
    return filteredMenu(
      t('Quantity'),
      t('Filter: area, people, bytes…'),
      () => {
        const list = el(documentRef, 'div', 'treemap-menu-list');
        const groups = variableEntries(catalog(), filter);
        if (!groups.length)
          list.append(
            el(
              documentRef,
              'div',
              'treemap-menu-empty',
              t('No quantity matches'),
            ),
          );
        for (const group of groups) {
          list.append(
            el(
              documentRef,
              'div',
              'treemap-menu-group',
              `${group.quantity} › ${group.unit}`,
            ),
          );
          for (const row of group.variables) {
            const item = el(documentRef, 'button', 'treemap-menu-item');
            item.type = 'button';
            item.setAttribute('role', 'option');
            item.setAttribute(
              'aria-selected',
              String(row.id === parsed?.variable),
            );
            item.append(el(documentRef, 'span', 'treemap-menu-name', row.name));
            if (!row.available) {
              item.disabled = true;
              item.setAttribute('aria-disabled', 'true');
              item.title = row.why;
              item.append(el(documentRef, 'span', 'treemap-menu-why', row.why));
            }
            item.addEventListener('click', () => {
              const definition = treemapVariable(row.id);
              const first =
                definition?.sequences?.[0]?.address ||
                (definition?.groupings?.[0]
                  ? `${row.id}://${definition.groupings[0]}`
                  : null) ||
                catalog()
                  ?.variables?.find((v) => v.id === row.id)
                  ?.groupings?.slice(0, 1)
                  .map((id) => `${row.id}://${id}`)[0];
              open = null;
              filter = '';
              if (first) set(first);
              render();
            });
            list.append(item);
          }
        }
        return list;
      },
    );
  }

  function sequenceMenu(parsed) {
    return filteredMenu(t('Sequence'), t('Filter sequences'), () => {
      const list = el(documentRef, 'div', 'treemap-menu-list');
      const entries = sequenceEntries(parsed?.variable, catalog(), filter);
      if (!entries.length)
        list.append(
          el(
            documentRef,
            'div',
            'treemap-menu-empty',
            filter ? t('No sequence matches') : t('No ready-made sequence'),
          ),
        );
      for (const entry of entries) {
        const item = el(
          documentRef,
          'button',
          'treemap-menu-item treemap-menu-sequence',
        );
        item.type = 'button';
        item.setAttribute('role', 'option');
        item.setAttribute(
          'aria-selected',
          String(entry.address === store.get().address),
        );
        item.title = entry.cuts;
        item.append(
          el(
            documentRef,
            'span',
            'treemap-menu-name',
            entry.title || entry.cuts,
          ),
          el(documentRef, 'span', 'treemap-menu-reveals', entry.reveals),
        );
        if (entry.why) {
          item.disabled = true;
          item.setAttribute('aria-disabled', 'true');
          item.append(el(documentRef, 'span', 'treemap-menu-why', entry.why));
        }
        item.addEventListener('click', () => {
          open = null;
          filter = '';
          set(entry.address);
          render();
        });
        list.append(item);
      }
      return list;
    });
  }

  function addMenu(address) {
    const menu = el(documentRef, 'div', 'treemap-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', t('Add a cut'));
    const options = addableGroupings(address, catalog());
    for (const id of options) {
      for (const join of ['/', '*']) {
        const item = el(documentRef, 'button', 'treemap-menu-item');
        item.type = 'button';
        item.setAttribute('role', 'option');
        item.textContent =
          join === '*'
            ? t('× {cut} (overlay)', { cut: groupingName(id) })
            : t('/ {cut} (within)', { cut: groupingName(id) });
        item.addEventListener('click', () => {
          open = null;
          set(addGrouping(address, id, join));
          render();
        });
        menu.append(item);
      }
    }
    if (!options.length)
      menu.append(
        el(
          documentRef,
          'div',
          'treemap-menu-empty',
          t('Every cut it takes is in use'),
        ),
      );
    return menu;
  }

  function addressField(address) {
    const row = el(documentRef, 'div', 'treemap-address');
    const input = el(documentRef, 'input', 'treemap-address-text');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = draft ?? addressText(address);
    input.setAttribute('aria-label', t('Address'));
    input.title = t('The address: Enter applies it, Escape puts it back');
    if (problem) input.setAttribute('aria-invalid', 'true');
    input.addEventListener('input', () => {
      draft = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const read = readAddressText(input.value, catalog());
        if (!read.ok) {
          problem = read.message;
          draft = input.value;
          render();
          documentRef.querySelector?.('.treemap-address-text')?.focus?.();
          return;
        }
        draft = null;
        problem = '';
        if (read.address === store.get().address) render();
        else set(read.address);
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        draft = null;
        problem = '';
        render();
      }
    });
    row.append(input);
    if (problem) {
      const why = el(documentRef, 'div', 'treemap-address-problem', problem);
      why.setAttribute('role', 'alert');
      row.append(why);
    }
    return row;
  }

  function render() {
    const address = store.get().address;
    const parsed = (() => {
      const read = parseTreemapAddress(address);
      return read.ok ? read : null;
    })();
    const definition = treemapVariable(parsed?.variable);
    // Keep the field's focus and caret across a redraw while it is edited.
    const active = documentRef.activeElement;
    const editing =
      active?.classList?.contains?.('treemap-address-text') &&
      container.contains(active);
    const caret = editing ? active.selectionStart : null;
    container.replaceChildren();
    // The quantity.
    const quantity = el(
      documentRef,
      'button',
      'treemap-pick treemap-pick-variable',
    );
    quantity.type = 'button';
    quantity.setAttribute('aria-haspopup', 'listbox');
    quantity.setAttribute('aria-expanded', String(open === 'variable'));
    quantity.title = t('Quantity, unit and variable');
    const unit = TREEMAP_UNITS[parsed?.unit];
    quantity.textContent = parsed
      ? `${variableName(parsed.variable)} · ${unit?.symbol || (unit?.name ? t(unit.name) : parsed.unit)}`
      : '—';
    quantity.addEventListener('click', () => {
      open = open === 'variable' ? null : 'variable';
      filter = '';
      render();
    });
    // The sequence.
    const sequence = el(
      documentRef,
      'button',
      'treemap-pick treemap-pick-sequence',
    );
    sequence.type = 'button';
    sequence.setAttribute('aria-haspopup', 'listbox');
    sequence.setAttribute('aria-expanded', String(open === 'sequence'));
    sequence.title = t('Ready-made cuts');
    const current = definition?.sequences?.find((s) => s.address === address);
    sequence.textContent = current
      ? t(current.title || current.reveals)
      : t('Own cut');
    sequence.addEventListener('click', () => {
      open = open === 'sequence' ? null : 'sequence';
      filter = '';
      render();
    });
    const head = el(documentRef, 'div', 'treemap-bar-head');
    head.append(quantity, sequence);
    // The pills.
    const pills = el(documentRef, 'div', 'treemap-pills');
    pills.setAttribute('role', 'list');
    pills.setAttribute('aria-label', t('Cuts, outermost first'));
    (parsed?.groupings || []).forEach((id, index) => {
      if (index > 0) {
        const overlay = parsed.joins[index - 1] === '*';
        const join = el(
          documentRef,
          'button',
          'treemap-join',
          overlay ? '×' : '/',
        );
        join.type = 'button';
        join.title = overlay
          ? t('Overlay: switch to nesting within')
          : t('Nested within: switch to an overlay');
        join.addEventListener('click', () => set(toggleJoin(address, index)));
        pills.append(join);
      }
      const pill = el(documentRef, 'span', 'treemap-pill');
      pill.setAttribute('role', 'listitem');
      pill.tabIndex = 0;
      pill.draggable = true;
      pill.title = t('Drag, or use the arrow keys, to reorder');
      pill.append(
        el(documentRef, 'span', 'treemap-pill-name', groupingName(id)),
      );
      if (parsed.groupings.length > 1) {
        const remove = el(documentRef, 'button', 'treemap-pill-remove', '×');
        remove.type = 'button';
        remove.setAttribute(
          'aria-label',
          t('Remove {cut}', { cut: groupingName(id) }),
        );
        remove.addEventListener('click', () =>
          set(removeGrouping(address, index)),
        );
        pill.append(remove);
      }
      pill.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft')
          set(moveGrouping(address, index, index - 1));
        else if (event.key === 'ArrowRight')
          set(moveGrouping(address, index, index + 1));
        else if (event.key === 'Delete' || event.key === 'Backspace')
          set(removeGrouping(address, index));
      });
      pill.addEventListener('dragstart', (event) => {
        dragFrom = index;
        event.dataTransfer?.setData?.('text/plain', String(index));
      });
      pill.addEventListener('dragover', (event) => event.preventDefault());
      pill.addEventListener('drop', (event) => {
        event.preventDefault();
        if (dragFrom !== null) set(moveGrouping(address, dragFrom, index));
        dragFrom = null;
      });
      pills.append(pill);
    });
    const add = el(documentRef, 'button', 'treemap-add', '+');
    add.type = 'button';
    add.setAttribute('aria-haspopup', 'listbox');
    add.setAttribute('aria-expanded', String(open === 'add'));
    add.setAttribute('aria-label', t('Add a cut'));
    add.title = t('Add a cut');
    add.addEventListener('click', () => {
      open = open === 'add' ? null : 'add';
      render();
    });
    pills.append(add);
    container.append(addressField(address), head, pills);
    if (editing) {
      const field = container.querySelector('.treemap-address-text');
      field?.focus?.();
      if (caret !== null) field?.setSelectionRange?.(caret, caret);
    }
    if (open === 'variable') container.append(variableMenu(parsed));
    else if (open === 'sequence') container.append(sequenceMenu(parsed));
    else if (open === 'add') container.append(addMenu(address));
  }

  // The store moved (a pill, a menu, the breadcrumb, a link): the text
  // follows unless it is being edited with a problem showing.
  removers.push(
    store.subscribe(() => {
      if (!problem) draft = null;
      render();
    }),
  );
  render();
  return {
    render,
    destroy() {
      for (const remove of removers.splice(0)) remove();
      container.replaceChildren();
    },
  };
}
