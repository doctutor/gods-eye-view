/**
 * Pairs of Cottereau's polity and Cliopatria's that differ by definition,
 * not by an error of the extraction or the matching: both name the same
 * polity, but draw a different thing under the name (a record of a few
 * square kilometres, an empire without its colony). Their IoU says nothing
 * of either's borders, so the borders' quality report keeps them apart
 * from its summary, and the review lists them.
 *
 * Each was checked by hand against the frames and Cliopatria's records;
 * `why` says what differs. `label` is matched against the start of his
 * label's text (a label's two lines are read as one: "Russian America").
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const DIFFERENCES = Object.freeze([
  {
    label: 'Iroquois',
    cliopatria: 'Haudenosaunee',
    from: 1763,
    to: 1768,
    why: "After 1763 Cottereau sets the Iroquois in the Ohio valley, a strip of the British crimson between its lines (about 97,000 km²); Cliopatria's Haudenosaunee of 1763–68 is Iroquoia in New York, 43,334 km².",
  },
  {
    label: 'Russian',
    cliopatria: 'Russian Empire',
    from: 1799,
    to: 1867,
    why: "Russian America: Cliopatria's Russian Empire stops at the Bering Strait, without Alaska, which Cottereau fills in its own colour.",
  },
  {
    label: 'Nejd',
    cliopatria: 'Emirate of Nejd',
    from: 1895,
    to: 1904,
    why: "Cliopatria's Emirate of Nejd of 1895–1904 is a record of 53 km² (40.5° E, 28.8° N); Cottereau draws the emirate's land.",
  },
  {
    label: 'Zhou',
    cliopatria: 'Later Zhou',
    from: -750,
    to: -257,
    why: "Cliopatria's Later Zhou (the Eastern Zhou) is the royal domain at Luoyang, 4,000 to 10,000 km²; Cottereau's Zhou covers the plain to the east.",
  },
  {
    label: 'Zagwe',
    cliopatria: 'Zagwe dynasty',
    from: 947,
    to: 1271,
    why: "Cliopatria's Zagwe dynasty is the Lasta highlands, 14,454 km²; Cottereau draws it from the highlands to the Red Sea coast, about 275,000 km².",
  },
  {
    label: 'Volga Bulgaria',
    cliopatria: 'Volga Bulgaria',
    from: 674,
    to: 1235,
    why: "Cottereau's Volga Bulgaria lies north-west of Cliopatria's (56–59° N against 54.5–56.6° N). Kazan, drawn in the same framing, overlaps Cliopatria's at 0.5, so the framing is not the cause.",
  },
]);

/** The difference a pair is (his label's text, the Cliopatria name, the year), or null. */
export function differenceOf(label, cliopatria, year) {
  if (!label || !cliopatria) return null;
  return (
    DIFFERENCES.find(
      (d) =>
        d.cliopatria === cliopatria &&
        String(label).startsWith(d.label) &&
        d.from <= year &&
        year <= d.to,
    ) || null
  );
}
