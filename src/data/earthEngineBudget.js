/**
 * Personal fork: the day's Earth Engine spend, made visible. Every fresh
 * Blocks view costs Earth Engine requests (about 40 computePixels) against
 * EARTH_ENGINE_DAILY_TILES (20,000 by default), which the server counts
 * per layer per day (server/providers/earthEngine.js). This store polls
 * GET /api/earth-engine/budget every BUDGET_POLL_MS while it is active
 * (while Blocks is drawn: src/app/lego.js) and never otherwise, for the
 * HUD's EE line and the Blocks status line's tooltip.
 */
import { formatNumber, t } from '../i18n/index.js';

export const BUDGET_ROUTE = '/api/earth-engine/budget';
export const BUDGET_POLL_MS = 60_000;
/** The shares (%) the server warns at: amber, then red. */
const DEFAULT_WARN_AT = Object.freeze([50, 90]);

/** A budget answer checked into shape, or null. */
export function normalizeBudget(raw) {
  const dailyTiles = Number(raw?.dailyTiles);
  const total = Number(raw?.total);
  if (!Number.isFinite(dailyTiles) || !Number.isFinite(total)) return null;
  const used = {};
  for (const [id, n] of Object.entries(raw?.used || {}))
    if (Number.isFinite(Number(n))) used[id] = Number(n);
  const warnAt =
    Array.isArray(raw?.warnAt) && raw.warnAt.length >= 2
      ? raw.warnAt.map(Number)
      : [...DEFAULT_WARN_AT];
  return { date: String(raw?.date || ''), dailyTiles, total, used, warnAt };
}

/** 'ok', 'amber' (from the first warning share) or 'red' (the second). */
export function budgetLevel(budget) {
  if (!budget || !(budget.dailyTiles > 0)) return 'ok';
  const share = (budget.total / budget.dailyTiles) * 100;
  const [amber, red] = budget.warnAt || DEFAULT_WARN_AT;
  if (share >= red) return 'red';
  if (share >= amber) return 'amber';
  return 'ok';
}

/** "EE 1,240 / 20,000 today". */
export const budgetText = (budget) =>
  t('EE {used} / {budget} today', {
    used: formatNumber(budget.total),
    budget: formatNumber(budget.dailyTiles),
  });

/**
 * The longer account, for tooltips: the day, the total against the budget,
 * and the layers that spent it, most first.
 */
export function budgetTitle(budget) {
  const layers = Object.entries(budget.used)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id} ${formatNumber(n)}`)
    .join(' · ');
  const head = t(
    'Earth Engine tiles fetched today ({date}, UTC): {used} of the {budget} a day',
    {
      date: budget.date,
      used: formatNumber(budget.total),
      budget: formatNumber(budget.dailyTiles),
    },
  );
  return layers ? `${head}. ${layers}` : head;
}

/**
 * The budget store: `setActive(true)` asks now and every `intervalMs`,
 * `setActive(false)` stops and forgets (so the line hides); listeners hear
 * the latest budget, or null.
 */
export function createBudgetStore({
  fetchImpl = (...args) => globalThis.fetch(...args),
  intervalMs = BUDGET_POLL_MS,
  setIntervalImpl = (...args) => setInterval(...args),
  clearIntervalImpl = (...args) => clearInterval(...args),
} = {}) {
  let latest = null;
  let timer = null;
  let generation = 0;
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener(latest);
      } catch (error) {
        console.warn('[EarthEngine] budget listener failed:', error);
      }
    }
  };
  const ask = async () => {
    const mine = generation;
    let next = null;
    try {
      const response = await fetchImpl(BUDGET_ROUTE, {
        headers: { Accept: 'application/json' },
      });
      next = response?.ok ? normalizeBudget(await response.json()) : null;
    } catch {
      next = null;
    }
    // Stopped (or restarted) while asking: this answer is not shown.
    if (mine !== generation || timer === null) return;
    latest = next;
    emit();
  };
  return {
    get: () => latest,
    get active() {
      return timer !== null;
    },
    setActive(on) {
      if (on && timer === null) {
        generation += 1;
        timer = setIntervalImpl(ask, intervalMs);
        ask();
      } else if (!on && timer !== null) {
        generation += 1;
        clearIntervalImpl(timer);
        timer = null;
        if (latest !== null) {
          latest = null;
          emit();
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared = null;
/** The page's store. */
export function earthEngineBudgetStore() {
  shared ||= createBudgetStore();
  return shared;
}
