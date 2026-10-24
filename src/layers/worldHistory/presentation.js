/**
 * Personal fork: the World history layer's words: years as BC and AD, a
 * polity's span and area, and its card's lines. Pure but for the catalog.
 */
import { t } from '../../i18n/index.js';
import { CLIOPATRIA_CREDIT_TEXT, yearParts } from '../../data/worldHistory.js';

/** A year as the panel and the card say it: "500 BC", "1 AD". */
export function yearText(year) {
  const { n, era } = yearParts(year);
  return era === 'BC'
    ? t('{year} BC', { year: n })
    : t('{year} AD', { year: n });
}

/** A span of years: "27 BC – 476 AD", or one year. */
export const spanText = (from, to) =>
  from === to
    ? yearText(from)
    : t('{from} – {to}', { from: yearText(from), to: yearText(to) });

const groups = (n) =>
  Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** An area in km², grouped by thousands. */
export const areaText = (km2) => t('{area} km²', { area: groups(km2) });

/**
 * A clicked polity's card lines: Cottereau's label under Cliopatria's name
 * when they differ, the record's years, its area, its Wikipedia title, and
 * the credit.
 */
export function cardDetails(record, { title = '' } = {}) {
  const lines = [];
  if (title && title !== record.name)
    lines.push(t('Cliopatria: {name}', { name: record.name }));
  lines.push(spanText(record.from, record.to));
  if (record.area) lines.push(areaText(record.area));
  if (record.wikipedia)
    lines.push(t('Wikipedia: {title}', { title: record.wikipedia }));
  // i18n-ignore: the data's credit line, as its licence asks
  lines.push(CLIOPATRIA_CREDIT_TEXT);
  return lines;
}

/** A Wikipedia title's page (Cliopatria gives the title). */
export const wikipediaUrl = (title) =>
  title
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`
    : '';

// ── The private Cottereau borders overlay ───────────────────────────────

/** A flag of an extracted region, in words. */
export function flagText(flag) {
  if (flag === 'split') return t('split from a shared fill');
  if (flag === 'joined') return t('joined parts of one colour');
  if (flag === 'beside') return t('label set beside it');
  if (flag === 'unlabelled') return t('unlabelled');
  return flag;
}

/** An IoU as the cards say it: two decimals. */
export const iouText = (iou) => (Math.round(iou * 100) / 100).toFixed(2);

/** A Cottereau region's card title: his label, or that it has none. */
export const regionTitle = (region) => region.label || t('Unlabelled region');

/**
 * A clicked Cottereau region's card lines: the Cliopatria polity his label
 * is matched to, their IoU in the sample's year, its flags, the sample's
 * year, and that the overlay is private.
 */
export function bordersCardDetails(region, { sampleYear }) {
  const lines = [];
  if (!region.unlabelled)
    lines.push(
      region.cliopatria
        ? t('Cliopatria: {name}', { name: region.cliopatria })
        : t('No Cliopatria match'),
    );
  if (Number.isFinite(region.iou))
    lines.push(t('IoU with Cliopatria: {iou}', { iou: iouText(region.iou) }));
  if (region.flags?.length)
    lines.push(
      t('Flags: {flags}', { flags: region.flags.map(flagText).join(', ') }),
    );
  lines.push(t('Sample year {year}', { year: yearText(sampleYear) }));
  if (region.areaKm2) lines.push(areaText(region.areaKm2));
  lines.push(t('Cottereau borders (private)'));
  return lines;
}

/** A Cliopatria card's lines for the Cottereau polities matched to it. */
export const matchLines = (matches) =>
  matches.map((m) =>
    t('IoU with Cottereau’s {label}: {iou}', {
      label: m.label,
      iou: iouText(m.iou),
    }),
  );
