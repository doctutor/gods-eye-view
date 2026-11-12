/**
 * Personal fork: the TREEMAP window's address bar (docs/TREEMAP-PLAN.md):
 * a quantity drop-down (quantity › unit › variable, filtered as you type,
 * a variable not built shown disabled with the reason), a sequence
 * drop-down in the catalogue's order with each one's "reveals" line, and
 * the address's groupings as pills: remove, reorder (drag, or the arrow
 * keys on a pill), add from the cuts the variable takes, and `/` or `×`
 * between two. The edits are pure functions of the address (exported for
 * the tests); the bar writes the result to the store.
 */
import { t, msg } from '../i18n/index.js';
import { formatAddress, parseAddress } from '../data/treemapWindowAddress.js';
import { TREEMAP_GROUPING_NAMES } from '../data/treemapCatalogPlan.js';

const NOT_BUILT = msg('Not built yet');

const groupingName = (id) =>
  TREEMAP_GROUPING_NAMES[id] ? t(TREEMAP_GROUPING_NAMES[id]) : id;

/** The address with its grouping at `index` taken out. */
export function removeGrouping(address, index) {
  const parsed = parseAddress(address);
  if (!parsed || !parsed.groupings[index]) return address;
  const groupings = parsed.groupings.filter((_, k) => k !== index);
  return formatAddress(parsed.variable, groupings) ?? address;
}

/** The address with the grouping at `from` moved to `to`. */
export function moveGrouping(address, from, to) {
  const parsed = parseAddress(address);
  if (!parsed) return address;
  const list = [...parsed.groupings];
  if (!list[from] || to < 0 || to >= list.length || from === to) return address;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return formatAddress(parsed.variable, list) ?? address;
}

/** The address with `groupingId` added last (`/`), if it is not there. */
export function addGrouping(address, groupingId, join = '/') {
  const parsed = parseAddress(address);
  if (!parsed || parsed.groupings.some((g) => g.id === groupingId))
    return address;
  return (
    formatAddress(parsed.variable, [
      ...parsed.groupings,
      { id: groupingId, join: join === '*' ? '*' : '/' },
    ]) ?? address
  );
}

/** The join before the grouping at `index` (1 or more) flipped, `/` ⇄ `*`. */
export function toggleJoin(address, index) {
  const parsed = parseAddress(address);
  if (!parsed || index < 1 || !parsed.groupings[index]) return address;
  const list = parsed.groupings.map((g, k) =>
    k === index ? { ...g, join: g.join === '*' ? '/' : '*' } : g,
  );
  return formatAddress(parsed.variable, list) ?? address;
}

/** The groupings the variable takes (per `catalog`) not yet in the address. */
export function addableGroupings(address, catalog) {
  const parsed = parseAddress(address);
  if (!parsed) return [];
  const variable = catalog?.variables?.find((v) => v.id === parsed.variable);
  const used = new Set(parsed.groupings.map((g) => g.id));
  return (variable?.groupings || []).filter((id) => !used.has(id));
}

/**
 * The quantity drop-down's entries: the plan's variables (and any the
 * catalogue adds), grouped quantity › unit, filtered by `filter` against
 * their quantity, unit, name and id; each {id, name, available, why}.
 * A variable the catalogue does not list is not built.
 * @returns {{quantity: string, unit: string, variables: object[]}[]}
 */
export function variableEntries(plan, catalog, filter = '') {
  const byId = new Map((catalog?.variables || []).map((v) => [v.id, v]));
  const needle = String(filter).trim().toLowerCase();
  const rows = plan.map((entry) => {
    const known = byId.get(entry.id);
    return {
      id: entry.id,
      quantity: t(entry.quantity),
      unit: entry.unit.length > 3 ? t(entry.unit) : entry.unit,
      name: t(entry.name),
      available: known ? known.available !== false : false,
      why: known ? known.why || '' : t(NOT_BUILT),
    };
  });
  for (const extra of catalog?.variables || [])
    if (!plan.some((entry) => entry.id === extra.id))
      rows.push({
        id: extra.id,
        quantity: extra.id.split('/')[0],
        unit: extra.id.split('/')[0],
        name: extra.id.split('/')[1],
        available: extra.available !== false,
        why: extra.why || '',
      });
  const kept = needle
    ? rows.filter((row) =>
        [row.quantity, row.unit, row.name, row.id].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : rows;
  const groups = [];
  for (const row of kept) {
    let group = groups.find(
      (g) => g.quantity === row.quantity && g.unit === row.unit,
    );
    if (!group)
      groups.push(
        (group = { quantity: row.quantity, unit: row.unit, variables: [] }),
      );
    group.variables.push(row);
  }
  return groups;
}

function el(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{container: Element, documentRef: Document, store: object,
 *   catalogPlan: object[], catalog: () => object|null}} options
 */
export function createAddressBar({
  container,
  documentRef,
  store,
  catalogPlan,
  catalog,
}) {
  const removers = [];
  let open = null; // 'variable' | 'sequence' | 'add' | null
  let filter = '';
  let dragFrom = null;

  const set = (address) => {
    if (address !== store.get().address) store.setAddress(address);
  };

  const planOf = (variable) =>
    catalogPlan.find((entry) => entry.id === variable) || null;

  function closeMenus() {
    if (!open) return;
    open = null;
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

  function variableMenu(parsed) {
    const menu = el(documentRef, 'div', 'treemap-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', t('Quantity'));
    const input = el(documentRef, 'input', 'treemap-filter');
    input.type = 'search';
    input.placeholder = t('Filter: area, people, bytes…');
    input.value = filter;
    input.setAttribute('aria-label', t('Filter quantities'));
    input.addEventListener('input', () => {
      filter = input.value;
      const list = menu.querySelector('.treemap-menu-list');
      list?.replaceWith(listOf());
    });
    const listOf = () => {
      const list = el(documentRef, 'div', 'treemap-menu-list');
      const groups = variableEntries(catalogPlan, catalog(), filter);
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
            item.append(el(documentRef, 'span', 'treemap-menu-why', row.why));
          }
          item.addEventListener('click', () => {
            const first = planOf(row.id)?.sequences?.[0]?.address;
            open = null;
            filter = '';
            set(first || `${row.id}://`);
            render();
          });
          list.append(item);
        }
      }
      return list;
    };
    menu.append(input, listOf());
    queueMicrotask?.(() => input.focus?.());
    return menu;
  }

  function sequenceMenu(parsed) {
    const menu = el(documentRef, 'div', 'treemap-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', t('Sequence'));
    const entry = planOf(parsed?.variable);
    const supported = new Set(
      catalog()?.variables?.find((v) => v.id === parsed?.variable)?.groupings ||
        [],
    );
    for (const sequence of entry?.sequences || []) {
      const item = el(
        documentRef,
        'button',
        'treemap-menu-item treemap-menu-sequence',
      );
      item.type = 'button';
      item.setAttribute('role', 'option');
      const seqParsed = parseAddress(sequence.address);
      const cuts = (seqParsed?.groupings || [])
        .map(
          (g, k) =>
            `${k ? (g.join === '*' ? ' × ' : ' / ') : ''}${groupingName(g.id)}`,
        )
        .join('');
      item.setAttribute(
        'aria-selected',
        String(sequence.address === store.get().address),
      );
      item.title = cuts;
      item.append(
        el(
          documentRef,
          'span',
          'treemap-menu-name',
          sequence.title ? t(sequence.title) : cuts,
        ),
        el(documentRef, 'span', 'treemap-menu-reveals', t(sequence.reveals)),
      );
      // Waits on a table not built, or on its first cut: disabled with the
      // reason. A deeper cut not built only stops the view there.
      const first = seqParsed?.groupings?.[0];
      const why = sequence.needs
        ? t('Waits on {cuts}', { cuts: t(sequence.needs) })
        : first && !supported.has(first.id)
          ? t('Waits on {cuts}', { cuts: groupingName(first.id) })
          : null;
      if (why) {
        item.disabled = true;
        item.append(el(documentRef, 'span', 'treemap-menu-why', why));
      }
      item.addEventListener('click', () => {
        open = null;
        set(sequence.address);
        render();
      });
      menu.append(item);
    }
    if (!menu.childElementCount)
      menu.append(
        el(
          documentRef,
          'div',
          'treemap-menu-empty',
          t('No ready-made sequence'),
        ),
      );
    return menu;
  }

  function addMenu(address) {
    const menu = el(documentRef, 'div', 'treemap-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', t('Add a cut'));
    const options = addableGroupings(address, catalog());
    for (const id of options) {
      for (const join of parseAddress(address)?.groupings.length
        ? ['/', '*']
        : ['/']) {
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

  function render() {
    const address = store.get().address;
    const parsed = parseAddress(address);
    const entry = planOf(parsed?.variable);
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
    quantity.textContent = entry
      ? `${t(entry.name)} · ${entry.unit.length > 3 ? t(entry.unit) : entry.unit}`
      : parsed?.variable || '—';
    quantity.addEventListener('click', () => {
      open = open === 'variable' ? null : 'variable';
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
    const current = entry?.sequences?.find((s) => s.address === address);
    sequence.textContent = current
      ? t(current.title || current.reveals)
      : t('Own cut');
    sequence.addEventListener('click', () => {
      open = open === 'sequence' ? null : 'sequence';
      render();
    });
    const head = el(documentRef, 'div', 'treemap-bar-head');
    head.append(quantity, sequence);
    // The pills.
    const pills = el(documentRef, 'div', 'treemap-pills');
    pills.setAttribute('role', 'list');
    pills.setAttribute('aria-label', t('Cuts, outermost first'));
    (parsed?.groupings || []).forEach((grouping, index) => {
      if (index > 0) {
        const join = el(
          documentRef,
          'button',
          'treemap-join',
          grouping.join === '*' ? '×' : '/',
        );
        join.type = 'button';
        join.title =
          grouping.join === '*'
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
        el(documentRef, 'span', 'treemap-pill-name', groupingName(grouping.id)),
      );
      const remove = el(documentRef, 'button', 'treemap-pill-remove', '×');
      remove.type = 'button';
      remove.setAttribute(
        'aria-label',
        t('Remove {cut}', { cut: groupingName(grouping.id) }),
      );
      remove.addEventListener('click', () =>
        set(removeGrouping(address, index)),
      );
      pill.append(remove);
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
    container.append(head, pills);
    if (open === 'variable') container.append(variableMenu(parsed));
    else if (open === 'sequence') container.append(sequenceMenu(parsed));
    else if (open === 'add') container.append(addMenu(address));
  }

  render();
  return {
    render,
    destroy() {
      for (const remove of removers.splice(0)) remove();
      container.replaceChildren();
    },
  };
}
