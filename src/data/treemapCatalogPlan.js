/**
 * Personal fork: the curated catalogue (src/data/treemapCatalog.js, shared
 * with the service) in the shape the TREEMAP window's menus read: each
 * variable's quantity, unit, name and sizing mode, and its ready-made
 * sequences in the order of interest, each with its title, the line saying
 * what it reveals, and what it waits on. The service's /catalog says which
 * variables are built and which cuts each takes. English in msg(): the
 * window translates it.
 */
import {
  TREEMAP_GROUPINGS,
  TREEMAP_NEEDS,
  TREEMAP_QUANTITIES,
  TREEMAP_UNITS,
  TREEMAP_VARIABLES,
} from './treemapCatalog.js';

const QUANTITY_LABELS = new Map(
  TREEMAP_QUANTITIES.map((quantity) => [quantity.id, quantity.label]),
);

/**
 * @type {{id: string, quantity: string, unit: string, name: string,
 *   mode: 'additive'|'product'|'relative', live: boolean, sequences:
 *   {address: string, title: string, reveals: string, needs: string|null}[]
 *   }[]}
 */
export const TREEMAP_CATALOG_PLAN = Object.freeze(
  TREEMAP_VARIABLES.map((variable) => {
    const unit = TREEMAP_UNITS[variable.unit];
    return Object.freeze({
      id: variable.id,
      quantity: QUANTITY_LABELS.get(variable.quantity) || variable.quantity,
      // The symbol where the unit has one (m², B), else its name (count).
      unit: unit?.symbol || unit?.name || variable.unit,
      name: variable.label,
      mode: variable.mode,
      live: variable.source === 'live',
      sequences: Object.freeze(
        variable.sequences.map((sequence) =>
          Object.freeze({
            address: sequence.address,
            title: sequence.title,
            reveals: sequence.reveals,
            needs: sequence.needs
              ? TREEMAP_NEEDS[sequence.needs] || null
              : null,
          }),
        ),
      ),
    });
  }),
);

/** What each grouping is called in the window (msg: translated there). */
export const TREEMAP_GROUPING_NAMES = Object.freeze(
  Object.fromEntries(
    TREEMAP_GROUPINGS.map((grouping) => [grouping.id, grouping.label]),
  ),
);
