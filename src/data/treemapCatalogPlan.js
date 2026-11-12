/**
 * Personal fork: the treemap navigator's curated catalogue as the plan
 * writes it (docs/TREEMAP-PLAN.md, "The catalogue"): each variable's
 * quantity, unit, name and sizing mode, and its ready-made pill sequences
 * in the order of interest, each with the line saying what it reveals.
 * The window's stand-in until the shared catalogue (src/data/
 * treemapCatalog.js, worker2's) lands; the service's /catalog says which
 * variables are built and which cuts each takes. English in msg(): the
 * window translates it.
 */
import { msg } from '../i18n/marker.js';

const seq = (address, reveals) => ({ address, reveals });

/**
 * @type {{id: string, quantity: string, unit: string, name: string,
 *   mode: 'additive'|'product'|'relative', sequences: {address: string,
 *   reveals: string}[]}[]}
 */
export const TREEMAP_CATALOG_PLAN = Object.freeze([
  {
    id: 'm2/surface-area',
    quantity: msg('Area'),
    unit: 'm²',
    name: msg('Surface area'),
    mode: 'additive',
    sequences: [
      seq(
        'm2/surface-area://admin.continent/admin.country/admin.region/admin.district',
        msg('The shape of the administered world'),
      ),
      seq(
        'm2/surface-area://admin.country*landcover.class',
        msg('How much of each country is forest, crop, bare or built'),
      ),
    ],
  },
  {
    id: 'count/people',
    quantity: msg('Number'),
    unit: msg('count'),
    name: msg('People'),
    mode: 'additive',
    sequences: [
      seq(
        'count/people://admin.continent/admin.country/admin.region/locality.place',
        msg('Where people are, against where land is'),
      ),
      seq(
        'count/people://admin.country*locality.kind',
        msg('City countries and village countries'),
      ),
    ],
  },
  {
    id: 'count/places',
    quantity: msg('Number'),
    unit: msg('count'),
    name: msg('Places'),
    mode: 'additive',
    sequences: [
      seq(
        'count/places://place.category/admin.country/admin.region',
        msg('What the mapped economy consists of'),
      ),
      seq(
        'count/places://admin.country/place.category',
        msg('Where mapping is thin'),
      ),
    ],
  },
  {
    id: 'count/buildings',
    quantity: msg('Number'),
    unit: msg('count'),
    name: msg('Buildings'),
    mode: 'additive',
    sequences: [
      seq(
        'count/buildings://admin.continent/admin.country/admin.region',
        msg('The built world: how many'),
      ),
    ],
  },
  {
    id: 'm2/building-footprint',
    quantity: msg('Area'),
    unit: 'm²',
    name: msg('Building footprint'),
    mode: 'additive',
    sequences: [
      seq(
        'm2/building-footprint://admin.continent/admin.country/admin.region',
        msg('The built world: sprawl'),
      ),
    ],
  },
  {
    id: 'm3/building-volume',
    quantity: msg('Volume'),
    unit: 'm³',
    name: msg('Building volume'),
    mode: 'additive',
    sequences: [
      seq(
        'm3/building-volume://admin.continent/admin.country/admin.region',
        msg('The built world: height'),
      ),
    ],
  },
  {
    id: 'count/wikipedia-articles',
    quantity: msg('Number'),
    unit: msg('count'),
    name: msg('Wikipedia articles'),
    mode: 'additive',
    sequences: [
      seq(
        'count/wikipedia-articles://wikipedia.language/admin.country',
        msg('Which places the world has written about, and in which language'),
      ),
      seq(
        'count/wikipedia-articles://admin.country/wikipedia.class',
        msg('What is written about each country'),
      ),
    ],
  },
  {
    id: 'byte/wikipedia-text',
    quantity: msg('Information'),
    unit: 'B',
    name: msg('Wikipedia text'),
    mode: 'additive',
    sequences: [
      seq(
        'byte/wikipedia-text://wikipedia.language/admin.country',
        msg('How much has been written, and in which language'),
      ),
    ],
  },
  {
    id: 'm2/polity-area',
    quantity: msg('Area'),
    unit: 'm²',
    name: msg('Historical polity area'),
    mode: 'additive',
    sequences: [
      seq(
        'm2/polity-area://history.period/history.polity',
        msg('Empires rising and shrinking, period by period'),
      ),
    ],
  },
  {
    id: 'count/aircraft',
    quantity: msg('Number'),
    unit: msg('count'),
    name: msg('Aircraft now'),
    mode: 'additive',
    sequences: [
      seq(
        'count/aircraft://aircraft.class/aircraft.type',
        msg('The live air picture the globe half-hides'),
      ),
    ],
  },
  {
    id: 'count/vessels',
    quantity: msg('Number'),
    unit: msg('count'),
    name: msg('Vessels now'),
    mode: 'additive',
    sequences: [
      seq(
        'count/vessels://vessel.family/vessel.type',
        msg('The live sea picture the globe half-hides'),
      ),
    ],
  },
  {
    id: 'm3/land-volume',
    quantity: msg('Volume'),
    unit: 'm³',
    name: msg('Land volume'),
    mode: 'product',
    sequences: [
      seq(
        'm3/land-volume://admin.continent/admin.country',
        msg('Elevation by area: high plateaus against the flat giants'),
      ),
    ],
  },
]);

/** What each grouping is called in the window (msg: translated there). */
export const TREEMAP_GROUPING_NAMES = Object.freeze({
  'admin.continent': msg('Continent'),
  'admin.country': msg('Country'),
  'admin.region': msg('Region'),
  'admin.district': msg('District'),
  'locality.place': msg('Place'),
  'locality.kind': msg('Kind of place'),
  'place.category': msg('Category'),
  'landcover.class': msg('Land cover'),
  'wikipedia.language': msg('Language'),
  'wikipedia.class': msg('Article class'),
  'history.period': msg('Period'),
  'history.polity': msg('Polity'),
  'aircraft.class': msg('Aircraft class'),
  'aircraft.type': msg('Aircraft type'),
  'vessel.family': msg('Vessel family'),
  'vessel.type': msg('Vessel type'),
  'time.year': msg('Year'),
});
