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
