import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import {
  PROPERTY_POINTS_BELOW_M,
  PROPERTY_SOURCE,
  propertyMetric,
} from '../../data/propertySales.js';
import { METRIC_KEYS, legendValues, sparkline } from './property.js';
import { isDefaultScale } from '../../maps/colourScale.js';
import { scaleRowLegend } from '../../ui/colourScaleWidget.js';

/**
 * Personal fork: what the Property sales layer says in words: its chips
 * (one metric at a time), the legend, the row's status, a building's card
 * and the source's caveat.
 */

export const METRIC_WORDS = Object.freeze({
  price: Object.freeze({
    chip: msg('PRICE'),
    title: msg('Median last-sale price per hexagon, sales since 2015'),
  }),
  ppsf: Object.freeze({
    chip: msg('$/SQFT'),
    title: msg('Median sale price per square foot, sales since 2015'),
  }),
  year: Object.freeze({
    chip: msg('YEAR BUILT'),
    title: msg('Median year built per hexagon'),
  }),
  sales: Object.freeze({
    chip: msg('SALES'),
    title: msg('Properties with a recorded sale, any year'),
  }),
  properties: Object.freeze({
    chip: msg('PROPERTIES'),
    title: msg('Property records: parcels, and units where listed'),
  }),
});

const TYPE_WORDS = Object.freeze({
  single_family: msg('Single family'),
  condo: msg('Condo'),
  townhouse: msg('Townhouse'),
  apartment: msg('Apartment'),
  multi_family: msg('Multi-family'),
  manufactured: msg('Manufactured'),
  land: msg('Land'),
  other: msg('Other property'),
});
export const typeWords = (key) => (TYPE_WORDS[key] ? t(TYPE_WORDS[key]) : '');

/** Dollars, whole: $1,250,000. */
export const usd = (value) =>
  formatNumber(value, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

/** A short value for the legend: $250K, $1.2M, $180, 1950, 1.2K. */
export function shortValue(metric, value) {
  if (!Number.isFinite(value)) return '—';
  if (metric === 'year') return String(Math.round(value));
  const compact = formatNumber(value, {
    notation: 'compact',
    maximumSignificantDigits: 2,
  });
  return metric === 'price' || metric === 'ppsf' ? `$${compact}` : compact;
}

/** The caveat every card and the row carry. */
export const CAVEAT = msg(
  'Public records as published by realestatedataset.com: not checked against the county',
);

/** The status line. */
export function statusText(status, index) {
  if (!status) return '';
  switch (status.state) {
    case 'unconfigured':
      return t('Run npm run property:build for the Property sales layer');
    case 'loading':
      return t('Reading the property records…');
    case 'failed':
      return t('Property records unavailable');
    case 'ready':
      break;
    default:
      return '';
  }
  if (status.mode === 'hexes')
    return [
      t('Hexes: resolution {res}, {count} cells', {
        res: status.res,
        count: formatNumber(status.count),
      }),
      t('buildings below {height} km', {
        height: Math.round(PROPERTY_POINTS_BELOW_M / 1000),
      }),
    ].join(' · ');
  const parts = [
    tn(status.count, '{count} building', '{count} buildings', {
      count: formatNumber(status.count),
    }),
  ];
  if (status.saturated) parts.push(t('a sample; zoom in for all'));
  if (index?.records)
    parts.push(
      t('{count} records in the index', {
        count: formatNumber(index.records),
      }),
    );
  return parts.join(' · ');
}

/**
 * @param {{metric: string, onMetric: (key: string) => void, domain: object|null,
 *   status: object|null, index: object|null, enabled: boolean,
 *   opacity: number, onOpacity: (value: number) => void}} input
 */
export function rowControls({
  metric,
  onMetric,
  domain,
  status,
  index,
  enabled,
  opacity,
  onOpacity,
  // The colour scale's row descriptor (colourScaleWidget.js).
  scale = null,
}) {
  const scaled = scale && !isDefaultScale(scale.model, scale.defaults);
  return {
    chips: METRIC_KEYS.map((key) => ({
      id: `metric-${key}`,
      label: t(METRIC_WORDS[key].chip),
      title: t(METRIC_WORDS[key].title),
      active: metric === key,
      onClick: () => onMetric(key),
    })),
    legend: scaled
      ? scaleRowLegend(scale)
      : legendValues(metric, domain).map((stop, i, all) => ({
          label: `${shortValue(metric, stop.value)}${i === all.length - 1 && propertyMetric(metric)?.scale !== 'linear' ? '+' : ''}`,
          color: stop.color,
        })),
    ...(scale ? { scale } : {}),
    slider: {
      label: t('Opacity {value}%', { value: Math.round(opacity * 100) }),
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(opacity * 100),
      onInput: (value) => onOpacity(value / 100),
    },
    info: enabled
      ? [statusText(status, index), t(CAVEAT)].filter(Boolean).join(' · ')
      : '',
  };
}

/** One record's facts in a line: 3 bd · 2 ba · 1,800 sqft · lot 9,000 sqft · built 1952. */
export function factsLine(record) {
  const parts = [];
  if (record.beds !== null) parts.push(t('{count} bd', { count: record.beds }));
  if (record.baths !== null)
    parts.push(t('{count} ba', { count: record.baths }));
  if (record.sqft)
    parts.push(t('{area} sqft', { area: formatNumber(record.sqft) }));
  if (record.lot)
    parts.push(t('lot {area} sqft', { area: formatNumber(record.lot) }));
  if (record.year) parts.push(t('built {year}', { year: record.year }));
  return parts.join(' · ');
}

/** A record's tax history: the latest assessment and tax, and the sparkline. */
export function taxLines(record) {
  const tax = record.tax || [];
  const latest = [...tax].reverse().find((entry) => entry.assessment !== null);
  const lines = [];
  if (latest)
    lines.push(
      latest.amount !== null
        ? t('Assessed {value} ({year}) · tax {tax}', {
            value: usd(latest.assessment),
            year: latest.year,
            tax: usd(latest.amount),
          })
        : t('Assessed {value} ({year})', {
            value: usd(latest.assessment),
            year: latest.year,
          }),
    );
  const bars = sparkline(tax.map((entry) => entry.assessment ?? NaN));
  if (bars)
    lines.push(
      // i18n-ignore: a sparkline of bars and its years
      `${bars} ${tax[0].year}–${tax.at(-1).year}`,
    );
  return lines;
}

/** A record's last sale in words, or ''. */
export const saleText = (sold) =>
  sold
    ? t('Last sale {price} on {date}', {
        price: usd(sold.price),
        date: sold.date,
      })
    : '';

/** The most unit lines a card lists. */
export const CARD_UNIT_LINES = 6;

/** A building's card: {title, details}. */
export function buildingCard(detail) {
  const { address } = detail;
  const title =
    [address.street, address.city].filter(Boolean).join(', ') || t('Property');
  const lines = [];
  const where = [
    detail.county?.name
      ? `${detail.county.name}, ${detail.county.state || address.state}`
      : '',
    address.zip,
  ]
    .filter(Boolean)
    .join(' · ');
  if (detail.records.length === 1) {
    const [record] = detail.records;
    const kind = typeWords(record.type);
    if (kind || where) lines.push([kind, where].filter(Boolean).join(' · '));
    const facts = factsLine(record);
    if (facts) lines.push(facts);
    const sale = saleText(record.sold);
    if (sale) lines.push(sale);
    const earlier = record.sales.filter(
      (s) => !record.sold || s.date !== record.sold.date,
    );
    if (earlier.length)
      lines.push(
        t('Earlier sales: {sales}', {
          sales: earlier
            .slice(-3)
            .map((s) => `${usd(s.price)} (${s.date.slice(0, 4)})`)
            .join(', '),
        }),
      );
    lines.push(...taxLines(record));
    if (record.apn) lines.push(t('Parcel {apn}', { apn: record.apn }));
  } else {
    const total = detail.records.length + detail.more;
    lines.push(
      [
        detail.stacked
          ? tn(
              total,
              '{count} record at this point',
              '{count} records at this point',
              {
                count: formatNumber(total),
              },
            )
          : tn(total, '{count} unit', '{count} units', {
              count: formatNumber(total),
            }),
        typeWords(detail.type),
        where,
      ]
        .filter(Boolean)
        .join(' · '),
    );
    const sold = detail.records.filter((r) => r.sold);
    if (sold.length)
      lines.push(
        tn(
          sold.length,
          '{count} with a recorded sale',
          '{count} with a recorded sale',
          {
            count: formatNumber(sold.length),
          },
        ),
      );
    for (const record of detail.records.slice(0, CARD_UNIT_LINES)) {
      const name = detail.stacked
        ? record.street
        : record.unit
          ? t('Unit {unit}', { unit: record.unit })
          : t('Building');
      const parts = [name];
      if (record.sold)
        parts.push(
          `${usd(record.sold.price)} (${record.sold.date.slice(0, 4)})`,
        );
      if (record.sqft)
        parts.push(t('{area} sqft', { area: formatNumber(record.sqft) }));
      lines.push(parts.join(' · '));
    }
    if (total > CARD_UNIT_LINES)
      lines.push(
        t('and {count} more', { count: formatNumber(total - CARD_UNIT_LINES) }),
      );
  }
  // i18n-ignore: the publisher's name and licence
  lines.push(`${PROPERTY_SOURCE}, CC0 · ${t(CAVEAT)}`);
  return { title, details: lines };
}
