// Personal fork: the treemap navigator's catalogue (docs/TREEMAP-PLAN.md):
// the quantities and units of the left drop-downs, the variables with their
// sizing mode, the groupings they can be cut by, and the ready-made pill
// sequences in the order of interest, each with the line saying what it
// reveals. Curated by hand, extended over time; pure data, shared by the
// service (/api/treemap) and the window. Not part of upstream God's Eye View.
import { msg } from '../i18n/index.js';
import {
  TREEMAP_ADDRESS_ERRORS,
  parseTreemapAddress,
  treemapGroupingParts,
} from './treemapAddress.js';

/** How a variable sizes a rectangle (the plan's three modes). */
export const TREEMAP_MODES = Object.freeze({
  // An extensive variable: every level is a true total.
  additive: 'additive',
  // An intensive variable × its extensive base: every level is a true total.
  product: 'product',
  // An intensive variable with no base: siblings compare, a parent is no sum.
  relative: 'relative',
});

/** The left drop-down's first level, then its units. */
export const TREEMAP_QUANTITIES = Object.freeze([
  Object.freeze({ id: 'area', label: msg('Area'), units: ['m2'] }),
  Object.freeze({ id: 'number', label: msg('Number'), units: ['count'] }),
  Object.freeze({ id: 'volume', label: msg('Volume'), units: ['m3'] }),
  Object.freeze({
    id: 'information',
    label: msg('Information'),
    units: ['byte'],
  }),
]);

/** Units: the address's token, how it is written, its quantity. */
export const TREEMAP_UNITS = Object.freeze({
  m2: Object.freeze({
    id: 'm2',
    symbol: 'm²',
    name: msg('square metres'),
    quantity: 'area',
  }),
  count: Object.freeze({
    id: 'count',
    symbol: '',
    name: msg('count'),
    quantity: 'number',
  }),
  m3: Object.freeze({
    id: 'm3',
    symbol: 'm³',
    name: msg('cubic metres'),
    quantity: 'volume',
  }),
  byte: Object.freeze({
    id: 'byte',
    symbol: 'B',
    name: msg('bytes'),
    quantity: 'information',
  }),
});

/**
 * Groupings: `kind` hierarchy (each member has one parent, the grouping
 * named by `parent`; a hierarchy's top has none) or overlay (an
 * independent partition). `cardinality` where it is fixed by the data.
 */
const grouping = (id, label, kind, extra = {}) =>
  Object.freeze({ id, ...treemapGroupingParts(id), kind, label, ...extra });
export const TREEMAP_GROUPINGS = Object.freeze([
  grouping('admin.continent', msg('Continent'), 'hierarchy', {
    cardinality: 7,
  }),
  grouping('admin.country', msg('Country'), 'hierarchy', {
    parent: 'admin.continent',
  }),
  grouping('admin.region', msg('Region'), 'hierarchy', {
    parent: 'admin.country',
  }),
  grouping('admin.district', msg('District'), 'hierarchy', {
    parent: 'admin.region',
  }),
  grouping('landcover.class', msg('Land cover'), 'overlay', {
    cardinality: 11,
  }),
  grouping('locality.place', msg('Place'), 'hierarchy', {
    parent: 'admin.region',
  }),
  grouping('locality.kind', msg('Kind of place'), 'overlay', {
    cardinality: 10,
  }),
  grouping('place.category', msg('Category'), 'overlay', { cardinality: 11 }),
  grouping('wikipedia.language', msg('Language'), 'overlay', {
    cardinality: 11,
  }),
  grouping('wikipedia.class', msg('Kind of article'), 'overlay', {
    cardinality: 4,
  }),
  grouping('history.period', msg('Period'), 'hierarchy'),
  grouping('history.polity', msg('Polity'), 'hierarchy', {
    parent: 'history.period',
  }),
  grouping('aircraft.class', msg('Aircraft class'), 'hierarchy', {
    cardinality: 10,
  }),
  grouping('aircraft.type', msg('Aircraft type'), 'hierarchy', {
    parent: 'aircraft.class',
  }),
  grouping('vessel.family', msg('Vessel family'), 'hierarchy', {
    cardinality: 10,
  }),
  grouping('vessel.type', msg('Vessel type'), 'hierarchy', {
    parent: 'vessel.family',
  }),
]);
const GROUPING_BY_ID = new Map(TREEMAP_GROUPINGS.map((g) => [g.id, g]));
export const treemapGrouping = (id) => GROUPING_BY_ID.get(id) || null;

/** What a sequence waits on before it can be answered (`needs`). */
export const TREEMAP_NEEDS = Object.freeze({
  'landcover-by-country': msg('land cover per country (phase 2)'),
  'elevation-by-country': msg('mean elevation per country (phase 2)'),
  'label-endpoint': msg('the label endpoint for live points'),
});

/**
 * The labels of tiles the tables make rather than read: the planet's
 * remainder, the part of a parent its children leave, the long tail of
 * places, and the kinds of place. English, for t() in the window.
 */
export const TREEMAP_LABELS = Object.freeze({
  ocean: msg('Oceans and unclaimed'),
  noRegion: msg('No region'),
  noDistrict: msg('No district'),
  otherPlaces: msg('Other places'),
  kinds: Object.freeze({
    city: msg('Cities'),
    town: msg('Towns'),
    village: msg('Villages'),
    hamlet: msg('Hamlets'),
    locality: msg('Other localities'),
  }),
});

const ADMIN = [
  'admin.continent',
  'admin.country',
  'admin.region',
  'admin.district',
];
const sequence = (address, title, reveals, needs) =>
  Object.freeze({ address, title, reveals, ...(needs ? { needs } : {}) });

/**
 * The variables, in the left drop-down's order; each with the groupings it
 * can be cut by and its sequences in the order of interest. `source` 'live'
 * marks a variable the window aggregates from the layers in the browser
 * rather than asking the service.
 */
export const TREEMAP_VARIABLES = Object.freeze(
  [
    {
      id: 'm2/surface-area',
      label: msg('Surface area'),
      mode: 'additive',
      groupings: [...ADMIN, 'landcover.class'],
      sequences: [
        sequence(
          'm2/surface-area://admin.continent/admin.country/admin.region/admin.district',
          msg('Continents, countries, regions, districts'),
          msg('The shape of the administered world.'),
        ),
        sequence(
          'm2/surface-area://admin.country*landcover.class',
          msg('Countries by land cover'),
          msg('How much of each country is forest, crop, bare or built.'),
          'landcover-by-country',
        ),
      ],
    },
    {
      id: 'count/people',
      label: msg('People'),
      mode: 'additive',
      groupings: [...ADMIN, 'locality.place', 'locality.kind'],
      sequences: [
        sequence(
          'count/people://admin.continent/admin.country/admin.region/locality.place',
          msg('Continents, countries, regions, places'),
          msg('Where people are, against where land is.'),
        ),
        sequence(
          'count/people://admin.country*locality.kind',
          msg('Countries by kind of place'),
          msg('City countries and village countries.'),
        ),
      ],
    },
    {
      id: 'count/places',
      label: msg('Places'),
      mode: 'additive',
      groupings: [...ADMIN, 'place.category'],
      sequences: [
        sequence(
          'count/places://place.category/admin.country/admin.region',
          msg('Categories, then countries and regions'),
          msg('What the mapped economy consists of.'),
        ),
        sequence(
          'count/places://admin.country/place.category',
          msg('Countries, then categories'),
          msg('Where mapping is thin.'),
        ),
      ],
    },
    {
      id: 'count/buildings',
      label: msg('Buildings'),
      mode: 'additive',
      groupings: [...ADMIN],
      sequences: [
        sequence(
          'count/buildings://admin.continent/admin.country/admin.region',
          msg('Continents, countries, regions'),
          msg('The built world by number of buildings.'),
        ),
      ],
    },
    {
      id: 'm2/building-footprint',
      label: msg('Building footprint'),
      mode: 'additive',
      groupings: [...ADMIN],
      sequences: [
        sequence(
          'm2/building-footprint://admin.continent/admin.country/admin.region',
          msg('Continents, countries, regions'),
          msg('The built world by ground covered: sprawl.'),
        ),
      ],
    },
    {
      id: 'm3/building-volume',
      label: msg('Building volume'),
      mode: 'additive',
      groupings: [...ADMIN],
      sequences: [
        sequence(
          'm3/building-volume://admin.continent/admin.country/admin.region',
          msg('Continents, countries, regions'),
          msg('The built world by volume: height against sprawl.'),
        ),
      ],
    },
    {
      id: 'count/wikipedia-articles',
      label: msg('Wikipedia articles'),
      mode: 'additive',
      groupings: [...ADMIN, 'wikipedia.language', 'wikipedia.class'],
      sequences: [
        sequence(
          'count/wikipedia-articles://wikipedia.language/admin.country',
          msg('Languages, then countries'),
          msg('Which places each language has written about.'),
        ),
        sequence(
          'count/wikipedia-articles://admin.country/wikipedia.class',
          msg('Countries, then kinds of article'),
          msg('Which places the world has written about, and what about.'),
        ),
      ],
    },
    {
      id: 'byte/wikipedia-text',
      label: msg('Wikipedia text'),
      mode: 'additive',
      groupings: [...ADMIN, 'wikipedia.language', 'wikipedia.class'],
      sequences: [
        sequence(
          'byte/wikipedia-text://wikipedia.language/admin.country',
          msg('Languages, then countries'),
          msg('How much each language has written about each place.'),
        ),
        sequence(
          'byte/wikipedia-text://admin.country/wikipedia.class',
          msg('Countries, then kinds of article'),
          msg('Where the written word piles up, and on what.'),
        ),
      ],
    },
    {
      id: 'm2/polity-area',
      label: msg('Historical polity area'),
      mode: 'additive',
      groupings: ['history.period', 'history.polity'],
      // A polity's area is a total only within one period.
      firstGrouping: 'history.period',
      sequences: [
        sequence(
          'm2/polity-area://history.period/history.polity',
          msg('Periods, then polities'),
          msg('Empires rising and shrinking, period by period.'),
        ),
      ],
    },
    {
      id: 'count/aircraft',
      label: msg('Aircraft now'),
      mode: 'additive',
      source: 'live',
      groupings: [...ADMIN, 'aircraft.class', 'aircraft.type'],
      sequences: [
        sequence(
          'count/aircraft://aircraft.class/aircraft.type',
          msg('Classes, then types'),
          msg('The live picture of the sky the globe half-hides.'),
        ),
        sequence(
          'count/aircraft://admin.country/aircraft.class',
          msg('Countries, then classes'),
          msg('Whose sky the aircraft are in.'),
          'label-endpoint',
        ),
      ],
    },
    {
      id: 'count/vessels',
      label: msg('Vessels now'),
      mode: 'additive',
      source: 'live',
      groupings: [...ADMIN, 'vessel.family', 'vessel.type'],
      sequences: [
        sequence(
          'count/vessels://vessel.family/vessel.type',
          msg('Families, then types'),
          msg('The live picture of the seas the globe half-hides.'),
        ),
      ],
    },
    {
      id: 'm3/land-volume',
      label: msg('Land volume'),
      mode: 'product',
      // The product's intensive field and its extensive base.
      product: Object.freeze({
        intensive: msg('mean elevation'),
        base: 'm2/surface-area',
      }),
      groupings: ['admin.continent', 'admin.country'],
      sequences: [
        sequence(
          'm3/land-volume://admin.continent/admin.country',
          msg('Continents, countries'),
          msg(
            'Elevation by surface area: Tibet and the Andes against the flat giants.',
          ),
          'elevation-by-country',
        ),
      ],
    },
  ].map((variable) =>
    Object.freeze({
      ...variable,
      unit: variable.id.slice(0, variable.id.indexOf('/')),
      quantity:
        TREEMAP_UNITS[variable.id.slice(0, variable.id.indexOf('/'))].quantity,
      groupings: Object.freeze([...variable.groupings]),
      sequences: Object.freeze(variable.sequences),
    }),
  ),
);
const VARIABLE_BY_ID = new Map(TREEMAP_VARIABLES.map((v) => [v.id, v]));
export const treemapVariable = (id) => VARIABLE_BY_ID.get(id) || null;

/** The catalogue's own errors, as TREEMAP_ADDRESS_ERRORS. */
export const TREEMAP_CATALOG_ERRORS = Object.freeze({
  variable: msg('There is no variable "{variable}"'),
  grouping: msg('There is no grouping "{grouping}"'),
  unsupported: msg('{variable} cannot be cut by {grouping}'),
  first: msg('{variable} needs {grouping} as its first grouping'),
});

/**
 * Read an address and check it against the catalogue: the variable exists,
 * and every grouping exists and is one the variable can be cut by. A `/`
 * between two groupings not in one hierarchy nests them all the same (the
 * sequences use it for "then"); `*` marks an overlay.
 * @returns the parse result with `definition` (the variable), or
 *   {ok: false, error, values} as parseTreemapAddress
 */
export function checkTreemapAddress(text) {
  const parsed = parseTreemapAddress(text);
  if (!parsed.ok) return parsed;
  const definition = treemapVariable(parsed.variable);
  const fail = (key, values) => ({
    ok: false,
    error: TREEMAP_CATALOG_ERRORS[key],
    values,
  });
  if (!definition) return fail('variable', { variable: parsed.variable });
  for (const id of parsed.groupings) {
    if (!treemapGrouping(id)) return fail('grouping', { grouping: id });
    if (!definition.groupings.includes(id))
      return fail('unsupported', { variable: parsed.variable, grouping: id });
  }
  if (
    definition.firstGrouping &&
    parsed.groupings[0] !== definition.firstGrouping
  )
    return fail('first', {
      variable: parsed.variable,
      grouping: definition.firstGrouping,
    });
  return { ...parsed, definition };
}

export { TREEMAP_ADDRESS_ERRORS };
