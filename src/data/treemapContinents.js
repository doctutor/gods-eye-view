// Personal fork: the treemap navigator's continents (docs/TREEMAP-PLAN.md):
// the seven, and the continent of every country and dependency code the
// Overture division areas carry (ISO 3166-1 alpha-2 and Overture's X*
// codes for disputed areas). Not part of upstream God's Eye View.
//
// The continents follow the UN M49 regions, the Americas split at Panama
// (Central America and the Caribbean are North America); Russia is Europe,
// Turkey and Cyprus Asia, as M49 has them. The far southern islands go
// where M49 puts them (Bouvet and South Georgia South America, the French
// Southern Lands Africa, Heard and McDonald Oceania); Antarctica alone is
// Antarctica.
import { msg } from '../i18n/index.js';

/** The seven continents: id, English name (for t()), and a box w,s,e,n. */
export const TREEMAP_CONTINENTS = Object.freeze(
  [
    { id: 'africa', label: msg('Africa'), box: [-26, -47, 64, 38] },
    { id: 'antarctica', label: msg('Antarctica'), box: [-180, -90, 180, -60] },
    { id: 'asia', label: msg('Asia'), box: [25, -11, 180, 82] },
    { id: 'europe', label: msg('Europe'), box: [-32, 34, 180, 82] },
    {
      id: 'north-america',
      label: msg('North America'),
      box: [-180, 5, -12, 84],
    },
    { id: 'oceania', label: msg('Oceania'), box: [110, -53, -120, 29] },
    {
      id: 'south-america',
      label: msg('South America'),
      box: [-92, -60, -26, 13],
    },
  ].map((continent) => Object.freeze(continent)),
);

const CODES = {
  africa:
    'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW IO KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TF TG TN TZ UG YT ZA ZM ZW XT XY',
  antarctica: 'AQ',
  asia: 'AE AF AM AZ BD BH BN BT CC CN CX CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE XA XB XC XD XG XH XI XL XM XN XO XP XQ XR XU XW XX XZ',
  europe:
    'AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XJ XK',
  'north-america':
    'AG AI AW BB BL BM BQ BS BZ CA CP CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI XE XS',
  oceania:
    'AS AU CK FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
  'south-america': 'AR BO BR BV CL CO EC FK GF GS GY PE PY SR UY VE',
};

const CONTINENT_OF = new Map(
  Object.entries(CODES).flatMap(([continent, codes]) =>
    codes.split(' ').map((code) => [code, continent]),
  ),
);

/** Every code the lookup knows, for tests and builds. */
export const TREEMAP_CONTINENT_CODES = Object.freeze([...CONTINENT_OF.keys()]);

/**
 * A country or dependency code's continent id, or null for a code the
 * lookup does not know.
 * @param {string} code ISO 3166-1 alpha-2 (or Overture's X* codes)
 */
export const continentOfCountry = (code) =>
  CONTINENT_OF.get(String(code || '').toUpperCase()) || null;

/** A continent by id, or null. */
export const treemapContinent = (id) =>
  TREEMAP_CONTINENTS.find((continent) => continent.id === id) || null;
