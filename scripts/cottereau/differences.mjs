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
    label: 'Qin',
    cliopatria: 'Qin',
    from: -350,
    to: -328,
    why: 'Cottereau\'s Qin of the mid-4th century BC lies in the far west (Gansu, 101–110° E), Cliopatria\'s in the Wei valley (108–112° E); his Wei and Han sit west of theirs likewise, and his "Zhou" covers Shandong.',
  },
  {
    label: 'Wei',
    cliopatria: 'Wei',
    from: -401,
    to: -229,
    why: 'Cottereau\'s Wei ("Weic" to the OCR) is drawn west of Han, around 107–111° E; Cliopatria\'s Wei lies east of it, on the Yellow River plain.',
  },
  {
    label: 'Balhae',
    cliopatria: 'Balhae',
    from: 705,
    to: 740,
    why: "Cottereau's early Balhae lies in Manchuria (43–47.5° N); Cliopatria's of 705–740 is to the south, in northern Korea (38.7–43.5° N). Silla and Tang beside it match at 0.9 and 0.57.",
  },
  {
    label: 'Gauda',
    cliopatria: 'Gauda Kingdom',
    from: 602,
    to: 611,
    why: "Cottereau's Gauda is west Bengal (84–88° E), with his Vanga to the east of it; Cliopatria's Gauda Kingdom of 602–611 is east Bengal (88–92° E).",
  },
  {
    label: 'Dai Viet',
    cliopatria: 'Đại Việt',
    from: 1533,
    to: 1592,
    why: "While Vietnam was split (1533–92), Cottereau's Dai Viet is the Lê south; Cliopatria's Đại Việt of those years is the north under the Mạc (20–23° N).",
  },
  {
    label: 'Majapahit',
    cliopatria: 'Majapahit',
    from: 1330,
    to: 1527,
    why: "Cottereau's Majapahit is its whole sphere in one pink: Borneo's coasts, south Sumatra, Malaya and the eastern isles; Cliopatria's is the Java and Bali core.",
  },
  {
    label: 'Teut',
    cliopatria: 'Teutonic Order',
    from: 1466,
    to: 1524,
    why: "After the Peace of Thorn (1466) Cottereau's \"Teut. State\" is Livonia and the Order's Prussia is drawn as Poland's; Cliopatria's Teutonic Order of those years is Prussia.",
  },
  {
    label: 'Qin',
    cliopatria: 'Zhai',
    from: -206,
    to: -204,
    why: "Cliopatria's Zhai records carry the Qin dynasty's Wikipedia title and Wikidata, so \"Qin\" is matched to them by name; in 206–204 BC Zhai is the kingdom of Zhai, 25,977 km² in northern Shaanxi, while Cottereau's Qin of 206 BC lies south of it, about 284,000 km².",
  },
  {
    label: 'Prussia',
    cliopatria: 'Kingdom of Prussia',
    from: 1807,
    to: 1863,
    why: "Cliopatria's Kingdom of Prussia records after 1807 are exclaves of 87 to 1,787 km² (1,067 km² in 1834–47); Prussia's land is in its German Confederation record, 281,000 km².",
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
