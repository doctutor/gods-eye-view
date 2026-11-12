/**
 * Personal fork: the treemap navigator's sample (docs/TREEMAP-PLAN.md): a
 * page-local stand-in for the service's first two variables, surface area
 * (`m2/surface-area`) and people (`count/people`), by continent, country
 * and, for a few countries, region. The window draws it while the service
 * does not answer (before worker2's tables land, or on a build without
 * them) and says so. Rounded public figures, km² and people; boxes are
 * rough [w, s, e, n]. Not the tables: no district level, no overlays.
 */
import { createRecordSource } from './treemapSources.js';
import { msg } from '../i18n/marker.js';

/** The planet's surface, km² (the root of `m2/surface-area`). */
export const PLANET_KM2 = 510_072_000;

const C = (code, name, continent, km2, peopleM, box, regions = null) => ({
  code,
  name,
  continent,
  km2,
  people: Math.round(peopleM * 1e6),
  box,
  regions,
});
const R = (code, name, km2, peopleM) => ({
  code,
  name,
  km2,
  people: Math.round(peopleM * 1e6),
});

const CONTINENTS = {
  AF: 'Africa',
  AN: 'Antarctica',
  AS: 'Asia',
  EU: 'Europe',
  NA: 'North America',
  OC: 'Oceania',
  SA: 'South America',
};

/** The service's continent keys (treemapContinents.js), so a link means
 * the same place on the sample. */
const CONTINENT_SLUGS = {
  AF: 'africa',
  AN: 'antarctica',
  AS: 'asia',
  EU: 'europe',
  NA: 'north-america',
  OC: 'oceania',
  SA: 'south-america',
};

const COUNTRIES = [
  C(
    'RU',
    'Russia',
    'EU',
    17_098_246,
    144,
    [27, 41, 180, 82],
    [
      R('FE', 'Far Eastern', 6_952_555, 7.9),
      R('SI', 'Siberian', 4_361_727, 16.8),
      R('UR', 'Ural', 1_818_497, 12.3),
      R('NW', 'Northwestern', 1_687_000, 13.9),
      R('VO', 'Volga', 1_037_000, 28.6),
      R('CE', 'Central', 650_200, 40.3),
      R('SO', 'Southern', 447_821, 16.6),
      R('NC', 'North Caucasian', 170_439, 10.2),
    ],
  ),
  C(
    'CA',
    'Canada',
    'NA',
    9_984_670,
    39,
    [-141, 42, -52, 83],
    [
      R('NU', 'Nunavut', 2_093_190, 0.04),
      R('QC', 'Quebec', 1_542_056, 8.9),
      R('NT', 'Northwest Territories', 1_346_106, 0.045),
      R('ON', 'Ontario', 1_076_395, 15.6),
      R('BC', 'British Columbia', 944_735, 5.6),
      R('AB', 'Alberta', 661_848, 4.7),
      R('SK', 'Saskatchewan', 651_036, 1.2),
      R('MB', 'Manitoba', 647_797, 1.45),
      R('YT', 'Yukon', 482_443, 0.045),
      R('AT', 'Atlantic provinces', 539_064, 2.5),
    ],
  ),
  C(
    'US',
    'United States',
    'NA',
    9_833_520,
    341,
    [-125, 24, -66, 49],
    [
      R('AK', 'Alaska', 1_723_337, 0.73),
      R('TX', 'Texas', 695_662, 30.5),
      R('CA', 'California', 423_967, 39),
      R('MT', 'Montana', 380_831, 1.1),
      R('NM', 'New Mexico', 314_917, 2.1),
      R('AZ', 'Arizona', 295_234, 7.4),
      R('NV', 'Nevada', 286_380, 3.2),
      R('CO', 'Colorado', 269_601, 5.9),
      R('OR', 'Oregon', 254_799, 4.2),
      R('WY', 'Wyoming', 253_335, 0.58),
      R('ZZ', 'The other 40 states and DC', 4_935_457, 246.3),
    ],
  ),
  C('CN', 'China', 'AS', 9_596_961, 1425, [73, 18, 135, 54]),
  C(
    'BR',
    'Brazil',
    'SA',
    8_515_767,
    217,
    [-74, -34, -34, 5],
    [
      R('N', 'North', 3_850_516, 18.9),
      R('CO', 'Centre-West', 1_606_239, 16.3),
      R('NE', 'Northeast', 1_552_167, 57.1),
      R('SE', 'Southeast', 924_565, 87.3),
      R('S', 'South', 576_774, 30.2),
    ],
  ),
  C('AU', 'Australia', 'OC', 7_692_024, 27, [113, -44, 154, -10]),
  C('IN', 'India', 'AS', 3_287_263, 1441, [68, 6, 97, 36]),
  C('AR', 'Argentina', 'SA', 2_780_400, 46, [-74, -55, -53, -22]),
  C('KZ', 'Kazakhstan', 'AS', 2_724_900, 20, [46, 40, 87, 56]),
  C('DZ', 'Algeria', 'AF', 2_381_741, 46, [-9, 19, 12, 37]),
  C('GL', 'Greenland', 'NA', 2_166_086, 0.057, [-73, 59, -11, 84]),
  C('CD', 'DR Congo', 'AF', 2_344_858, 109, [12, -14, 31, 5]),
  C('SA', 'Saudi Arabia', 'AS', 2_149_690, 37, [34, 16, 56, 33]),
  C('MX', 'Mexico', 'NA', 1_964_375, 129, [-118, 14, -86, 33]),
  C('ID', 'Indonesia', 'AS', 1_904_569, 279, [95, -11, 141, 6]),
  C('SD', 'Sudan', 'AF', 1_861_484, 50, [21, 8, 39, 23]),
  C('LY', 'Libya', 'AF', 1_759_540, 7, [9, 19, 25, 34]),
  C('IR', 'Iran', 'AS', 1_648_195, 89, [44, 25, 64, 40]),
  C('MN', 'Mongolia', 'AS', 1_564_110, 3.5, [87, 41, 120, 52]),
  C('PE', 'Peru', 'SA', 1_285_216, 34, [-81, -18, -68, 0]),
  C('TD', 'Chad', 'AF', 1_284_000, 19, [13, 7, 24, 24]),
  C('NE', 'Niger', 'AF', 1_267_000, 28, [0, 11, 16, 24]),
  C('AO', 'Angola', 'AF', 1_246_700, 37, [11, -18, 24, -4]),
  C('ML', 'Mali', 'AF', 1_240_192, 24, [-12, 10, 4, 25]),
  C('ZA', 'South Africa', 'AF', 1_221_037, 61, [16, -35, 33, -22]),
  C('CO', 'Colombia', 'SA', 1_141_748, 52, [-79, -4, -66, 13]),
  C('ET', 'Ethiopia', 'AF', 1_104_300, 129, [33, 3, 48, 15]),
  C('BO', 'Bolivia', 'SA', 1_098_581, 12, [-70, -23, -57, -9]),
  C('MR', 'Mauritania', 'AF', 1_030_700, 4.9, [-17, 14, -4, 27]),
  C('EG', 'Egypt', 'AF', 1_002_450, 114, [24, 22, 37, 32]),
  C('TZ', 'Tanzania', 'AF', 945_087, 69, [29, -12, 41, -1]),
  C('NG', 'Nigeria', 'AF', 923_768, 229, [2, 4, 15, 14]),
  C('VE', 'Venezuela', 'SA', 916_445, 29, [-73, 0, -59, 13]),
  C('PK', 'Pakistan', 'AS', 881_913, 245, [60, 23, 78, 37]),
  C('TR', 'Turkey', 'AS', 783_562, 86, [26, 35, 45, 42]),
  C('CL', 'Chile', 'SA', 756_102, 20, [-76, -56, -66, -17]),
  C('MM', 'Myanmar', 'AS', 676_578, 55, [92, 9, 102, 29]),
  C('AF', 'Afghanistan', 'AS', 652_230, 42, [60, 29, 75, 39]),
  C('FR', 'France', 'EU', 643_801, 66, [-5, 42, 8, 51]),
  C('UA', 'Ukraine', 'EU', 603_550, 37, [22, 44, 40, 52]),
  C('ES', 'Spain', 'EU', 505_990, 48, [-10, 36, 4, 44]),
  C('JP', 'Japan', 'AS', 377_975, 123, [129, 31, 146, 46]),
  C('DE', 'Germany', 'EU', 357_022, 84, [6, 47, 15, 55]),
  C('IT', 'Italy', 'EU', 301_340, 59, [7, 37, 19, 47]),
  C('GB', 'United Kingdom', 'EU', 242_495, 68, [-8, 50, 2, 59]),
  C('BD', 'Bangladesh', 'AS', 147_570, 173, [88, 21, 93, 27]),
  C('AQ', 'Antarctica', 'AN', 14_200_000, 0, [-180, -90, 180, -60]),
];

/** The sample's rows: a country, or one of its regions where it has them. */
export const SAMPLE_RECORDS = Object.freeze(
  COUNTRIES.flatMap((country) =>
    (country.regions || [null]).map((region) => ({
      continent: country.continent,
      country: country.code,
      countryName: country.name,
      region: region?.code ?? null,
      regionName: region?.name ?? null,
      km2: region ? region.km2 : country.km2,
      people: region ? region.people : country.people,
      box: country.box,
    })),
  ),
);

/** What the land rows leave of the planet: oceans and unclaimed land. */
const OCEANS_KM2 =
  PLANET_KM2 - SAMPLE_RECORDS.reduce((sum, record) => sum + record.km2, 0);

const continentOf = (record) =>
  record.continent === 'XX'
    ? { key: 'ocean', label: msg('Oceans and unclaimed') }
    : {
        key: CONTINENT_SLUGS[record.continent],
        label: CONTINENTS[record.continent],
      };
const countryOf = (record) =>
  record.country === 'XX'
    ? null
    : { key: record.country, label: record.countryName };
const regionOf = (record) =>
  record.region
    ? { key: `${record.country}-${record.region}`, label: record.regionName }
    : null;

const NOTE = msg('A rounded sample, not the service’s tables');
const ATTRIBUTION = msg('Sample: rounded national figures');

/** The sample as a record source (createRecordSource). */
export function createSampleSource() {
  const area = [
    ...SAMPLE_RECORDS,
    {
      continent: 'XX',
      country: 'XX',
      km2: OCEANS_KM2,
      people: 0,
      box: null,
    },
  ];
  return createRecordSource({
    id: 'sample',
    groupingInfo: {
      'admin.continent': { kind: 'hierarchy' },
      'admin.country': { kind: 'hierarchy', parent: 'admin.continent' },
      'admin.region': { kind: 'hierarchy', parent: 'admin.country' },
    },
    variables: [
      {
        id: 'm2/surface-area',
        mode: 'additive',
        records: () => area,
        value: (record) => record.km2 * 1e6,
        groupings: {
          'admin.continent': continentOf,
          'admin.country': countryOf,
          'admin.region': regionOf,
        },
        box: (record) => record.box,
        exact: false,
        note: NOTE,
        attribution: ATTRIBUTION,
      },
      {
        id: 'count/people',
        mode: 'additive',
        records: () => SAMPLE_RECORDS,
        value: (record) => record.people,
        groupings: {
          'admin.continent': continentOf,
          'admin.country': countryOf,
          'admin.region': regionOf,
        },
        box: (record) => record.box,
        exact: false,
        note: NOTE,
        attribution: ATTRIBUTION,
      },
    ],
  });
}
