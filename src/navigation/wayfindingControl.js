/**
 * Personal fork: wayfinding's controls beside the Move drop-down (the
 * ANALYSIS heading): the view (first person, behind, in front: T), Set
 * home (B) and Home (Shift+B), and a Places list of waypoints (add where
 * the walker stands, click one to go, ✕ to delete). Places live in this
 * browser (waypoints.js), never in a link.
 */
import { msg, t } from '../i18n/index.js';
import { placeText } from './waypoints.js';

export const VIEW_LABELS = Object.freeze({
  first: msg('1st'),
  back: msg('3rd'),
  front: msg('3rd, front'),
});

/**
 * @param {Document} doc
 * @param {{wayfinding: object, navStore: object, view: object}} parts
 * @returns {{element: HTMLElement, destroy: () => void}}
 */
export function createWayfindingControl(doc, { wayfinding, navStore, view }) {
  const wrap = doc.createElement('span');
  wrap.className = 'data-layer-group-control nav-way-control';
  const button = (className, text, title) => {
    const el = doc.createElement('button');
    el.type = 'button';
    el.className = className;
    el.textContent = text;
    el.title = title;
    return el;
  };
  const viewButton = button(
    'nav-view-btn',
    '',
    t('The view (T): first person, behind the walker, or in front of it'),
  );
  const setHome = button(
    'nav-sethome-btn',
    t('Set home'),
    t('Set home (B): where the walker stands, kept in this browser'),
  );
  const home = button(
    'nav-home-btn',
    t('Home'),
    t('Go home (Shift+B), walking there from Spectator'),
  );
  const placesToggle = button(
    'nav-places-btn',
    t('Places'),
    t('Waypoints: add where the walker stands, click one to go'),
  );
  placesToggle.setAttribute('aria-expanded', 'false');
  const panel = doc.createElement('div');
  panel.className = 'nav-places-panel';
  panel.hidden = true;
  const name = doc.createElement('input');
  name.type = 'text';
  name.className = 'nav-place-name';
  name.maxLength = 60;
  name.placeholder = t('Name');
  name.setAttribute('aria-label', t('Waypoint name'));
  const add = button(
    'nav-place-add',
    t('Add here'),
    t('Add a waypoint where the walker stands'),
  );
  const list = doc.createElement('ul');
  list.className = 'nav-places-list';
  const empty = doc.createElement('div');
  empty.className = 'nav-places-empty';
  empty.textContent = t('No waypoints yet');
  panel.append(name, add, list, empty);
  wrap.append(viewButton, setHome, home, placesToggle, panel);

  const row = (entry) => {
    const item = doc.createElement('li');
    item.className = 'nav-place';
    const go = button(
      'nav-place-go',
      entry.name,
      t('Go to {name}', { name: entry.name }),
    );
    go.dataset.id = entry.id;
    const where = doc.createElement('span');
    where.className = 'nav-place-where';
    where.textContent = placeText(entry);
    const remove = button(
      'nav-place-remove',
      '✕',
      t('Delete {name}', { name: entry.name }),
    );
    remove.dataset.id = entry.id;
    remove.setAttribute('aria-label', t('Delete {name}', { name: entry.name }));
    item.append(go, where, remove);
    return item;
  };

  const sync = () => {
    const walking = navStore.get() !== 'spectator';
    viewButton.hidden = !walking;
    viewButton.textContent = t(VIEW_LABELS[view.get()] ?? VIEW_LABELS.first);
    setHome.hidden = !walking;
    const where = wayfinding.waypoints.home();
    home.hidden = !where;
    home.title = where
      ? t('Go home (Shift+B): {where}', { where: placeText(where) })
      : t('Go home (Shift+B), walking there from Spectator');
    add.disabled = !walking;
    const entries = wayfinding.waypoints.list();
    list.replaceChildren(...entries.map(row));
    empty.hidden = entries.length > 0;
  };

  const blur = (el) => el.blur?.();
  const onView = () => {
    view.cycle();
    blur(viewButton);
  };
  const onSetHome = () => {
    wayfinding.setHome();
    blur(setHome);
  };
  const onHome = () => {
    wayfinding.goHome();
    blur(home);
  };
  const onToggle = () => {
    panel.hidden = !panel.hidden;
    placesToggle.setAttribute('aria-expanded', String(!panel.hidden));
    blur(placesToggle);
  };
  const onAdd = () => {
    if (wayfinding.addWaypoint(name.value)) name.value = '';
    blur(add);
  };
  const onList = (event) => {
    const target = event.target;
    const id = target?.dataset?.id;
    if (!id) return;
    if (target.classList?.contains('nav-place-remove')) wayfinding.remove(id);
    else wayfinding.goTo(id);
  };
  // Typing a name is not walking: the keys stay in the field.
  const onNameKey = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') onAdd();
  };
  const stop = (event) => event.stopPropagation();
  viewButton.addEventListener('click', onView);
  setHome.addEventListener('click', onSetHome);
  home.addEventListener('click', onHome);
  placesToggle.addEventListener('click', onToggle);
  add.addEventListener('click', onAdd);
  list.addEventListener('click', onList);
  name.addEventListener('keydown', onNameKey);
  wrap.addEventListener('click', stop);
  const offs = [
    navStore.subscribe(sync),
    view.subscribe(sync),
    wayfinding.waypoints.subscribe(sync),
  ];
  sync();
  return {
    element: wrap,
    destroy() {
      for (const off of offs) off?.();
      viewButton.removeEventListener('click', onView);
      setHome.removeEventListener('click', onSetHome);
      home.removeEventListener('click', onHome);
      placesToggle.removeEventListener('click', onToggle);
      add.removeEventListener('click', onAdd);
      list.removeEventListener('click', onList);
      name.removeEventListener('keydown', onNameKey);
      wrap.removeEventListener('click', stop);
    },
  };
}
