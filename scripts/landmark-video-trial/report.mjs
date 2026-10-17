#!/usr/bin/env node
/**
 * Personal fork: write the landmark-video trial's Markdown report from
 * results.json (trial.mjs), a manual-judgement file and the raw answers
 * under .gev-cache/landmark-video-trial/raw/. Nothing is fetched.
 *
 * usage: node scripts/landmark-video-trial/report.mjs --judgments FILE
 *          [--out DIR]
 */
import fs from 'node:fs';
import path from 'node:path';
import { LANDMARKS } from './trial.mjs';

const DIR = path.join('.gev-cache', 'landmark-video-trial');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const out = option('--out', DIR);
const results = JSON.parse(
  fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'),
);
const judged = JSON.parse(fs.readFileSync(option('--judgments', ''), 'utf8'));
const raw = (name) => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(DIR, 'raw', `${name}.json`), 'utf8'),
    );
  } catch {
    return null;
  }
};

// How often each source's candidates name the landmark in their title.
const videos = new Map();
for (const file of fs
  .readdirSync(path.join(DIR, 'raw'))
  .filter((f) => f.startsWith('videos-')))
  for (const item of raw(file.replace(/\.json$/, ''))?.items || [])
    videos.set(item.id, item);
const titled = { search: [0, 0], filmot: [0, 0] };
for (const landmark of LANDMARKS) {
  const names = (title) =>
    landmark.aliases.some((a) =>
      String(title || '')
        .toLowerCase()
        .includes(a),
    );
  for (const id of (raw(`search-${landmark.key}-any`)?.items || []).map(
    (i) => i.id?.videoId,
  )) {
    titled.search[1]++;
    if (names(videos.get(id)?.snippet?.title)) titled.search[0]++;
  }
  for (const video of (raw(`filmot-${landmark.key}`)?.result || []).slice(
    0,
    25,
  )) {
    titled.filmot[1]++;
    if (names(video.title)) titled.filmot[0]++;
  }
}

const tally = { about: 0, incidental: 0, wrong: 0 };
const scoresBy = { about: [], incidental: [], wrong: [] };
const enriched = results.results.map((entry) => {
  const marks = judged.judgments[entry.landmark.key] || [];
  const top = entry.top.map((candidate, i) => {
    const mark = marks[i];
    if (mark) {
      tally[mark[0]]++;
      scoresBy[mark[0]].push(candidate.score);
    }
    return mark
      ? { ...candidate, judgement: mark[0], judgementNote: mark[1] }
      : candidate;
  });
  return { ...entry, top };
});
const mean = (list) =>
  list.length
    ? (list.reduce((a, b) => a + b, 0) / list.length).toFixed(3)
    : '–';
const read = tally.about + tally.incidental + tally.wrong;

const lines = [];
const push = (...l) => lines.push(...l);
const esc = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ');
push(
  '# Videos about a place: Baltimore trial',
  '',
  `Generated ${results.generatedAt}. Code: \`scripts/landmark-video-trial/\` (personal fork, not in the app).`,
  '',
  '## Method',
  '',
  '- 12 Baltimore landmarks with Wikidata coordinates (items and positions in the table below).',
  '- YouTube: one `search.list` per landmark (`q` = landmark + Baltimore, `type=video`, `order=relevance`, `maxResults=25`, `videoDuration=any`, `regionCode=US`), then `videos.list` and `channels.list` for every candidate. Shorts (60 s or less) dropped.',
  '- Filmot (RapidAPI `getsearchsubtitles`, `lang=en`, `hitFormat=1`): one phrase query per landmark (with "Baltimore" for ambiguous names), first 25 videos and their timestamped hits.',
  '- One score per (video, landmark), 0–1:',
  '',
  '| evidence | weight |',
  '|---|---|',
  ...Object.entries(results.weights).map(([k, v]) => `| ${k} | ${v} |`),
  '',
  `Factors and penalties: length under 2 min or over 3 h ×${results.penalties.lengthFactor}; each other landmark named in the title or chapters −${results.penalties.competing} (at most −${results.penalties.competingMax}); an ambiguous name used about another city (NYC, DC) −${results.penalties.elsewhere}. Kind (tour / news / event / vlog / music / other) is guessed from title and channel words.`,
  '',
  '## Spend',
  '',
  `- YouTube: **${results.budget.youtubeUnits} / ${results.budget.youtubeLimit} units** (12 searches + 2 duration-comparison searches at 100 each, and ${results.budget.youtubeUnits - 1400} for videos.list/channels.list).`,
  `- Filmot: **${results.budget.filmotSearches} / ${results.budget.filmotLimit} caption searches**. Quota headers after the run: ${esc(JSON.stringify(results.budget.filmotQuota))}.`,
  '',
  '## Totals',
  '',
  `- Candidates: ${results.totals.youtubeCandidates} from YouTube search, ${results.totals.filmotCandidates} from Filmot; **overlap ${results.totals.overlap}** (the two sources barely meet); ${results.totals.unique} (video, landmark) pairs, ${results.totals.shortsDropped} Shorts dropped, ${results.totals.missingMetadata} without metadata (removed or private).`,
  `- Title names the landmark: YouTube search **${titled.search[0]} / ${titled.search[1]}**, Filmot **${titled.filmot[0]} / ${titled.filmot[1]}**.`,
  `- Geotags: ${results.totals.withGeotag} candidate videos carry a recording location at all; ${results.totals.geotagWithin1km} (video, landmark) pairs have one within 1 km.`,
  '',
  '## Manual read of the top 5 per landmark',
  '',
  `${read} read: **${tally.about} about the place, ${tally.incidental} incidental mention, ${tally.wrong} wrong** (${((100 * tally.about) / Math.max(1, read)).toFixed(0)}% about). Mean score: about ${mean(scoresBy.about)}, incidental ${mean(scoresBy.incidental)}.`,
  '',
  `${judged.about}`,
  '',
  '| landmark | about | incidental | wrong |',
  '|---|---|---|---|',
  ...enriched.map((e) => {
    const marks = e.top.slice(0, 5).map((c) => c.judgement);
    const n = (k) => marks.filter((m) => m === k).length;
    return `| ${e.landmark.name} | ${n('about')} | ${n('incidental')} | ${n('wrong')} |`;
  }),
  '',
);
for (const conclusion of judged.conclusions || []) push(conclusion, '');
for (const entry of enriched) {
  push(
    `## ${entry.landmark.name}`,
    '',
    `Wikidata ${entry.landmark.qid} at ${entry.landmark.lat}, ${entry.landmark.lon}. Search "${esc(entry.query)}"; Filmot ${esc(entry.filmotQuery)} (${entry.filmotTotal ?? '?'} videos in Filmot). Candidates: ${entry.counts.youtubeSearch} search, ${entry.counts.filmot} Filmot, ${entry.counts.overlap} in both.`,
    '',
  );
  if (entry.durationComparison)
    push(
      `Duration filter comparison: ${esc(JSON.stringify(entry.durationComparison))}.`,
      '',
    );
  push(
    '| # | score | kind | title | channel | from | evidence | read |',
    '|---|---|---|---|---|---|---|---|',
  );
  entry.top.forEach((c, i) =>
    push(
      `| ${i + 1} | ${c.score} | ${c.kind} | [${esc(c.title).slice(0, 90)}](${c.url}) | ${esc(c.channel)} | ${c.sources.join(' + ')} | ${esc(c.evidence.join('; '))} | ${c.judgement ? `**${c.judgement}**: ${esc(c.judgementNote)}` : ''} |`,
    ),
  );
  push('');
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, 'landmark-video-trial.md'),
  `${lines.join('\n')}\n`,
);
fs.writeFileSync(
  path.join(out, 'landmark-video-trial.json'),
  JSON.stringify(
    {
      ...results,
      titled,
      manual: {
        tally,
        meanScore: {
          about: mean(scoresBy.about),
          incidental: mean(scoresBy.incidental),
        },
      },
      results: enriched,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    tally,
    titled,
    meanScore: {
      about: mean(scoresBy.about),
      incidental: mean(scoresBy.incidental),
    },
  }),
);
