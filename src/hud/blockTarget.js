/**
 * Personal fork: the HUD's BLOCK line (src/navigation/target.js facts):
 * "39.321408 -76.629200 · L47 (47 m) · terrain · 3DEP 1 m", the place to
 * the block's own precision (degrees to half a block), the level and its
 * base above mean sea level, the material, and the elevation source; the
 * tooltip names the chunk and the block's region column.
 */
import { formatNumber, msg, t } from '../i18n/index.js';
import { degreeDecimals } from './precision.js';

const MATERIAL_LABELS = Object.freeze({
  terrain: msg('terrain'),
  water: msg('water'),
  building: msg('building'),
  grass: msg('grass'),
  forest: msg('forest'),
  road: msg('road'),
});

/** Degree decimals for a block's centre: the fewest that resolve half a block. */
export const blockDegreeDecimals = (blockM) =>
  degreeDecimals(Math.max(0.001, blockM / 2));

/** A height above sea level in whole metres, or to the block's decimals. */
function heightText(valueM, blockM) {
  const decimals =
    blockM >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(blockM)));
  return formatNumber(Number(valueM.toFixed(decimals)), {
    maximumFractionDigits: decimals,
  });
}

/**
 * The BLOCK line for targeted-block facts: {text, title}, null for none.
 */
export function formatBlockTarget(facts) {
  if (!facts) return null;
  const decimals = blockDegreeDecimals(facts.blockM);
  const place = `${facts.lat.toFixed(decimals)} ${facts.lon.toFixed(decimals)}`;
  const level = t('L{level} ({height} m)', {
    level: facts.level,
    height: heightText(facts.baseM, facts.blockM),
  });
  const material = MATERIAL_LABELS[facts.materialName]
    ? t(MATERIAL_LABELS[facts.materialName])
    : facts.materialName;
  const parts = [place, level, material];
  if (facts.sourceName) parts.push(facts.sourceName);
  return {
    text: parts.join(' · '),
    title: t('Chunk {chunk}, column {i} {j}, level {level}: {size} m blocks', {
      chunk: facts.chunkKey,
      i: facts.i,
      j: facts.j,
      level: facts.level,
      size: formatNumber(facts.blockM),
    }),
  };
}
