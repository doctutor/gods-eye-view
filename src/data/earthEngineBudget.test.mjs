// Personal fork: the day's Earth Engine spend, made visible
// (src/data/earthEngineBudget.js): the line's text and colours, the
// tooltip, and the store that polls only while it is active.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGET_POLL_MS,
  BUDGET_ROUTE,
  budgetLevel,
  budgetText,
  budgetTitle,
  createBudgetStore,
  normalizeBudget,
} from './earthEngineBudget.js';

const answer = (total, used = {}) => ({
  date: '2026-10-27',
  dailyTiles: 20000,
  used,
  total,
  warnAt: [50, 90],
});

test('the line: "EE 1,240 / 20,000 today"; amber from 50%, red from 90%', () => {
  const budget = normalizeBudget(answer(1240, { 'ee-elevation': 1180 }));
  assert.equal(budgetText(budget), 'EE 1,240 / 20,000 today');
  for (const [total, level] of [
    [0, 'ok'],
    [9_999, 'ok'],
    [10_000, 'amber'],
    [17_999, 'amber'],
    [18_000, 'red'],
    [25_000, 'red'],
  ])
    assert.equal(
      budgetLevel(normalizeBudget(answer(total))),
      level,
      String(total),
    );
  // A budget of 0 (off) or none is never coloured.
  assert.equal(budgetLevel({ ...budget, dailyTiles: 0 }), 'ok');
  assert.equal(budgetLevel(null), 'ok');
});

test('the tooltip: the day, the total against the budget, the layers that spent it, most first', () => {
  const budget = normalizeBudget(
    answer(1240, { 'ee-buildings': 60, 'ee-elevation': 1180, 'ee-rivers': 0 }),
  );
  assert.equal(
    budgetTitle(budget),
    'Earth Engine tiles fetched today (2026-10-27, UTC): 1,240 of the 20,000 a day. ee-elevation 1,180 · ee-buildings 60',
  );
  assert.equal(
    budgetTitle(normalizeBudget(answer(0))),
    'Earth Engine tiles fetched today (2026-10-27, UTC): 0 of the 20,000 a day',
  );
  assert.equal(normalizeBudget({ total: 'x' }), null);
  assert.deepEqual(
    normalizeBudget({ dailyTiles: 10, total: 2 }).warnAt,
    [50, 90],
  );
});

/** A fake fetch answering the budget, and a fake interval. */
function harness(totals) {
  const asked = [];
  let call = 0;
  const timers = new Map();
  let next = 1;
  return {
    asked,
    timers,
    fetchImpl: async (url) => {
      asked.push(url);
      const total = totals[Math.min(call++, totals.length - 1)];
      return { ok: true, json: async () => answer(total) };
    },
    setIntervalImpl: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearIntervalImpl: (id) => timers.delete(id),
    tick: async () => {
      for (const { fn } of timers.values()) fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('the store polls every 60 s only while active, and forgets on stopping (the line hides)', async () => {
  const h = harness([100, 250, 300]);
  const store = createBudgetStore(h);
  const heard = [];
  store.subscribe((budget) => heard.push(budget?.total ?? null));
  // Inactive: nothing asked, ever.
  await h.tick();
  assert.equal(h.asked.length, 0);
  store.setActive(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.asked, [BUDGET_ROUTE], 'asked at once');
  assert.equal([...h.timers.values()][0].ms, BUDGET_POLL_MS);
  assert.equal(BUDGET_POLL_MS, 60_000);
  assert.equal(store.get().total, 100);
  store.setActive(true);
  assert.equal(h.timers.size, 1, 'one timer');
  await h.tick();
  assert.equal(store.get().total, 250);
  store.setActive(false);
  assert.equal(h.timers.size, 0);
  assert.equal(store.get(), null);
  assert.deepEqual(heard, [100, 250, null]);
  await h.tick();
  assert.equal(h.asked.length, 2, 'nothing asked once stopped');
});

test('an answer arriving after the store stopped is not shown; a failed ask shows nothing', async () => {
  let release;
  const store = createBudgetStore({
    fetchImpl: () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, json: async () => answer(5) });
      }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  store.setActive(true);
  store.setActive(false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(), null);
  const failing = createBudgetStore({
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  failing.setActive(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failing.get(), null);
});
