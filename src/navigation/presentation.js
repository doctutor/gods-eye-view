/**
 * Personal fork: the navigation mode's drop-down beside the ANALYSIS
 * heading's Render control (src/navigation/store.js): Spectator (GEV's own
 * camera), Walk or Fly.
 */
import { msg, t } from '../i18n/index.js';

export const NAV_LABELS = Object.freeze({
  spectator: msg('Move: Spectator'),
  walk: msg('Move: Walk'),
  fly: msg('Move: Fly'),
});

/** A heading control: {element, destroy}. */
export function createNavigationHeadingControl(doc, store) {
  const wrap = doc.createElement('span');
  wrap.className = 'data-layer-group-control nav-mode-control';
  const select = doc.createElement('select');
  select.className = 'nav-mode-select';
  select.setAttribute('aria-label', t('Navigation mode'));
  select.title = t(
    'Walk: on the ground, WASD and the mouse (click the globe to look, Esc releases), Space jumps, Shift or W twice sprints. Fly: Space up, Shift down, W twice doubles the speed. Spectator: the usual camera',
  );
  for (const key of Object.keys(NAV_LABELS)) {
    const option = doc.createElement('option');
    option.value = key;
    option.textContent = t(NAV_LABELS[key]);
    select.appendChild(option);
  }
  // "Walk here": in Spectator, onto the block under the pointer (or the
  // view's centre); Shift-click flies there. G and Shift+G do the same.
  const here = doc.createElement('button');
  here.type = 'button';
  here.className = 'nav-here-btn';
  here.textContent = t('Here');
  here.title = t(
    'Walk here (G): onto the block under the pointer, or the ground at the view’s centre. Shift-click or Shift+G flies there',
  );
  wrap.append(select, here);
  const sync = () => {
    select.value = store.get();
    here.hidden = store.get() !== 'spectator';
  };
  const onHere = (event) => {
    store.requestEntry?.(event.shiftKey ? 'fly' : 'walk');
    here.blur();
  };
  here.addEventListener('click', onHere);
  const onChange = () => {
    store.set(select.value);
    // The keys go to the walker, not to the drop-down.
    select.blur();
  };
  const stop = (event) => event.stopPropagation();
  select.addEventListener('change', onChange);
  wrap.addEventListener('click', stop);
  const unsubscribe = store.subscribe(sync);
  sync();
  return {
    element: wrap,
    destroy() {
      unsubscribe();
      select.removeEventListener('change', onChange);
      here.removeEventListener('click', onHere);
      wrap.removeEventListener('click', stop);
    },
  };
}

/**
 * Two heading controls side by side in one heading (the layer panel takes
 * one per group): {element, destroy}.
 */
export function combineHeadingControls(doc, ...controls) {
  const made = controls.filter((control) => control?.element);
  const wrap = doc.createElement('span');
  wrap.className = 'data-layer-group-controls';
  for (const control of made) wrap.append(control.element);
  return {
    element: wrap,
    destroy() {
      for (const control of made) control.destroy?.();
    },
  };
}
