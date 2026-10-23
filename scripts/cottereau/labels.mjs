/**
 * The OCR'd labels of Cottereau's "History of the World: Every Year", one
 * sampled frame a line (labels-1fps.jsonl, from the manager's extraction
 * run): {t, year, boxes: [[cx, cy, w, h, text, conf], …]} in the
 * 3840 × 1920 frame's pixels. Cleaning drops the year box at the bottom
 * centre and noise, and joins the lines of a two-line label ("West" over
 * "Francia") into one.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

import fs from 'node:fs';

/** The year box at the bottom centre of the frame (and its ornament). */
export const YEAR_BOX = Object.freeze({
  x0: 1600,
  y0: 1620,
  x1: 2250,
  y1: 1920,
});
const YEAR_TEXT = /^\s*\d{1,4}\s*(BC|AD|BCE|CE)?\s*$/i;

/** Read the labels file: frames in order, boxes as objects. */
export function readFrames(file) {
  const frames = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // a line still being appended
    }
    frames.push({
      t: raw.t,
      year: raw.year,
      boxes: (raw.boxes || []).map(([cx, cy, w, h, text, conf]) => ({
        cx,
        cy,
        w,
        h,
        text: String(text),
        conf,
      })),
    });
  }
  return frames;
}

const inYearBox = (b) =>
  b.cx >= YEAR_BOX.x0 &&
  b.cx <= YEAR_BOX.x1 &&
  b.cy >= YEAR_BOX.y0 &&
  b.cy <= YEAR_BOX.y1;

/** Whether a box is a label at all: not the year, not digits or crumbs. */
export function isLabel(box) {
  if (inYearBox(box) || YEAR_TEXT.test(box.text)) return false;
  const letters = box.text.replace(/[^\p{L}]/gu, '');
  if (!letters.length) return false;
  if (box.h < 18 && letters.length < 2) return false;
  return true;
}

/**
 * Two boxes are lines of one label when one sits right under the other at
 * a line's pitch (the next baseline: about 1.1–1.3 line heights; two
 * labels stacked by chance sit further apart, 1.6 and more), centred on it
 * (a label is centred; neighbouring ones rarely are), in about the same
 * font (a box's height varies with its descenders: "Indus" over "Valley").
 */
export function stacked(upper, lower) {
  if (lower.cy <= upper.cy) return false;
  // An abbreviation ends its label: "Wal." over "Bul." over "Ottomans" are three.
  if (/\.\s*$/.test(upper.text)) return false;
  if (Math.max(upper.h, lower.h) / Math.min(upper.h, lower.h) > 1.5)
    return false;
  const pitch = (lower.cy - upper.cy) / ((upper.h + lower.h) / 2);
  if (pitch < 0.8 || pitch > 1.35) return false;
  const offset = Math.abs(upper.cx - lower.cx);
  return offset <= Math.max(12, 0.2 * Math.max(upper.w, lower.w));
}

/** Lines joined: a word broken by a hyphen ("Syro-" over "Hittites") without a space. */
export const joinLines = (lines) =>
  lines.reduce((text, line) => {
    const next = line.text.trim();
    if (!text) return next;
    return /-$/.test(text) ? `${text}${next}` : `${text} ${next}`;
  }, '');

/**
 * A frame's labels: the year box and noise dropped, stacked lines joined
 * top to bottom ("Volga" + "Bulgaria" → "Volga Bulgaria"), each with its
 * centre, size (the line height: a proxy for the polity's size) and lines.
 */
export function cleanFrame(frame) {
  const boxes = frame.boxes.filter(isLabel).sort((a, b) => a.cy - b.cy);
  const used = new Set();
  const labels = [];
  for (let i = 0; i < boxes.length; i++) {
    if (used.has(i)) continue;
    const lines = [boxes[i]];
    used.add(i);
    for (let again = true; again;) {
      again = false;
      const last = lines[lines.length - 1];
      for (let j = 0; j < boxes.length; j++) {
        if (used.has(j) || !stacked(last, boxes[j])) continue;
        lines.push(boxes[j]);
        used.add(j);
        again = true;
        break;
      }
    }
    const top = lines[0].cy - lines[0].h / 2;
    const bottom = lines.at(-1).cy + lines.at(-1).h / 2;
    labels.push({
      text: joinLines(lines),
      x: lines.reduce((s, l) => s + l.cx, 0) / lines.length,
      y: (top + bottom) / 2,
      h: lines.reduce((s, l) => s + l.h, 0) / lines.length,
      w: Math.max(...lines.map((l) => l.w)),
      lines: lines.length,
    });
  }
  return labels;
}
