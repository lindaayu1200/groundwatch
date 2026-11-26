// GROUNDWATCH value engine.
//
// The board is a pre-launch radar: every protocol in the snapshot with at least $5M of TVL and no
// on-chain token record is scored by one cross-sectional model fitted on the snapshot's own traded
// protocols. Nothing is hard-coded per protocol, nothing reads the clock or the environment, and
// every number on the board can be recomputed from the snapshot alone.
//
//   log10(mcap) = b0 + b1*log10(tvl) + b2*clamp(change_7d, -50, 50)/10 + b3*log10(age_days)
//
// The traded sample is cleaned before fitting: implausible market caps and a single MAD-based
// residual pass keep junk rows from dragging the fit. The fit is solved by ridge-regularised normal
// equations, then validated two ways (a walk-forward split and a leave-one-out sample spread across
// the market-cap range). Errors are measured in log space: the two MAPE fields are median absolute
// percentage errors, rmsle is the root mean squared log10 residual. All three travel on every row so
// the dashboard can audit the same model that produced the ranking.

/** The snapshot's protocol entry: exactly the fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted launch-value model, including the cleaning and validation audit. */
export interface LaunchModel {
  coefs: number[];
  walkForwardMape: number;
  looMape: number;
  rmsle: number;
  n: number;
  n_clean: number;
  n_dropped: number;
}

/** Audit context travels with a fitted model without adding fields to its public shape. */
const contexts = new WeakMap<LaunchModel, { asOf: string; universe: SnapshotProtocol[] }>();

export type Verdict = 'FARM' | 'WATCH' | 'SKIP';

/** A concrete, costed farm plan for one protocol. */
export interface FarmPlan {
  steps: string[];
  farm_cost_usd: number;
  farm_hours: number;
  yield_usd_per_day: number;
  verdict: Verdict;
}

/** One row of the radar board. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  on_watchlist: boolean;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  token_odds: number;
  farm_steps: string[];
  farm_cost_usd: number;
  farm_hours: number;
  yield_usd_per_day: number;
  verdict: Verdict;
  mape_walkforward: number;
  mape_loo: number;
  rmsle: number;
  n_clean: number;
  n_dropped: number;
}

/** The board's own audit figures. */
export interface RadarKpi {
  watchlist_covered: number;
  watchlist_total: number;
  rows: number;
  traded_n: number;
  walkforward_mape: number;
  loo_mape: number;
  rmsle: number;
  n_clean: number;
  n_dropped: number;
  min_value: number;
  max_value: number;
  distinct_values: number;
}

/** The dataset written to data.js. */
export interface RadarData {
  rows: BoardRow[];
  kpi: RadarKpi;
  generated_at_utc: string;
  model_coefs: number[];
}

/** Why the snapshot is not one the model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const RIDGE = 1e-6;
const DEFAULT_AS_OF = '2026-01-01';
const MIN_VALUE = 1_000_000;
const MAX_VALUE = 2_000_000_000_000;
const MIN_MCAP = 100_000;
const MIN_TVL = 1_000_000;
const MIN_RATIO = 0.05;
const MAX_RATIO = 50;
const MAD_SCALE = 1.4826;
const MAD_LIMIT = 3;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Deterministic string ordering, independent of any locale. */
function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The median, with an even sample averaged; untouched by the outliers the mean would follow. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from `listed_at` to `asOf`; an unknown or bad date gets the house 365-day fallback. */
export function ageDays(asOf: string, listedAt: string | null): number {
  if (listedAt === null) return 365;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 365;
  return Math.max(1, Math.floor((a - b) / DAY_MS));
}

/** A stable reference date for calls that pass only protocols, so results never depend on the clock. */
function referenceAsOf(protocols: SnapshotProtocol[]): string {
  let best = DEFAULT_AS_OF;
  for (const p of protocols) {
    if (p.listed_at !== null && /^\d{4}-\d{2}-\d{2}$/.test(p.listed_at) && cmpText(p.listed_at, best) > 0) {
      best = p.listed_at;
    }
  }
  return best;
}

/** The four design columns of a protocol, in the order of the fitted coefficients. */
function features(p: SnapshotProtocol, asOf: string): [number, number, number, number] {
  return [
    1,
    Math.log10(Math.max(1, finite(p.tvl_usd, 1))),
    clamp(finite(p.change_7d, 0), -50, 50) / 10,
    Math.log10(Math.max(1, ageDays(asOf, p.listed_at))),
  ];
}

/** Solve (X'X + ridge*I)b = X'y by Gauss-Jordan elimination with partial pivoting. */
function ridgeFit(x: number[][], y: number[]): number[] {
  const k = x[0]?.length ?? 4;
  const a: number[][] = [];
  for (let i = 0; i < k; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) {
      let sum = 0;
      for (let r = 0; r < x.length; r++) sum += (x[r]?.[i] ?? 0) * (x[r]?.[j] ?? 0);
      row.push(sum + (i === j ? RIDGE : 0));
    }
    // The right-hand side is X'y: y[i] here would fit the i-th intercept, not the sample.
    let rhs = 0;
    for (let r = 0; r < x.length; r++) rhs += (x[r]?.[i] ?? 0) * (y[r] ?? 0);
    row.push(rhs);
    a.push(row);
  }
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(a[r]?.[col] ?? 0) > Math.abs(a[pivot]?.[col] ?? 0)) pivot = r;
    }
    if (Math.abs(a[pivot]?.[col] ?? 0) < 1e-12) continue;
    if (pivot !== col) {
      const tmp = a[col]!;
      a[col] = a[pivot]!;
      a[pivot] = tmp;
    }
    const row = a[col]!;
    const divisor = row[col] ?? 1;
    for (let j = col; j <= k; j++) row[j] = (row[j] ?? 0) / divisor;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = a[r]?.[col] ?? 0;
      if (factor === 0) continue;
      const other = a[r]!;
      for (let j = col; j <= k; j++) other[j] = (other[j] ?? 0) - factor * (row[j] ?? 0);
    }
  }
  return a.map((row) => finite(row[k] ?? 0, 0));
}

/** Traded protocols, stably ordered by listing date. */
function sortedTraded(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols
    .filter((p) => p.mcap_usd !== null && Number.isFinite(p.mcap_usd))
    .sort((a, b) => cmpText(a.listed_at ?? '9999-99-99', b.listed_at ?? '9999-99-99') || cmpText(a.slug, b.slug));
}

/** Predict log10(mcap) from a coefficient vector. */
function predictLog(coefs: number[], p: SnapshotProtocol, asOf: string): number {
  const f = features(p, asOf);
  let logPrice = 0;
  for (let i = 0; i < coefs.length; i++) logPrice += (coefs[i] ?? 0) * (f[i] ?? 0);
  return logPrice;
}

/** Predict a market cap in dollars from a coefficient vector. */
function predict(coefs: number[], p: SnapshotProtocol, asOf: string): number {
  return Math.pow(10, predictLog(coefs, p, asOf));
}

/** The log10 residual of a prediction; a held-out guess and its actual market cap. */
function residual(coefs: number[], p: SnapshotProtocol, asOf: string): number {
  const guess = predictLog(coefs, p, asOf);
  const actual = Math.log10(Math.max(1, p.mcap_usd ?? 1));
  return Number.isFinite(guess) ? guess - actual : 0;
}

/** Median absolute percentage error from log-space predictions, not a mean of percentages. */
function medianApe(coefs: number[], rows: SnapshotProtocol[], asOf: string): number {
  if (rows.length === 0) return 0;
  return median(rows.map((p) => Math.min(1e6, Math.abs(Math.pow(10, residual(coefs, p, asOf)) - 1))));
}

/** Root mean squared log10 error of a set of held-out residuals. */
function rmsleFrom(residuals: number[]): number {
  if (residuals.length === 0) return 0;
  let sum = 0;
  for (const r of residuals) sum += r * r;
  return Math.sqrt(sum / residuals.length);
}

/** Fit on the already-cleaned traded rows. */
function fitOn(rows: SnapshotProtocol[], asOf: string): number[] {
  return ridgeFit(
    rows.map((p) => features(p, asOf)),
    rows.map((p) => Math.log10(Math.max(1, p.mcap_usd ?? 1))),
  );
}

/**
 * The traded rows a model may learn from. Implausible caps, tiny protocols and mcap/tvl ratios
 * outside [0.05, 50] go first; one robust pass then drops rows more than three MAD sigmas from the
 * first fit. The final fit runs on what survives, so no junk row is fitted twice.
 */
export function cleanTraded(protocols: SnapshotProtocol[], asOf?: string): SnapshotProtocol[] {
  const ref = asOf ?? referenceAsOf(protocols);
  const eligible = sortedTraded(protocols).filter((p) => {
    const mcap = p.mcap_usd ?? 0;
    const ratio = mcap / p.tvl_usd;
    return mcap > MIN_MCAP && p.tvl_usd > MIN_TVL && ratio >= MIN_RATIO && ratio <= MAX_RATIO;
  });
  if (eligible.length < 4) return eligible;
  const first = fitOn(eligible, ref);
  const deviations = eligible.map((p) => residual(first, p, ref));
  const center = median(deviations);
  const sigma = MAD_SCALE * median(deviations.map((r) => Math.abs(r - center)));
  if (!Number.isFinite(sigma) || sigma <= 0) return eligible;
  return eligible.filter((_, i) => Math.abs(deviations[i]!) <= MAD_LIMIT * sigma);
}

/** Fit the ridge model on the snapshot's cleaned traded protocols, with its audit figures. */
export function fitLaunchValue(protocols: SnapshotProtocol[], asOf?: string): LaunchModel {
  const ref = asOf ?? referenceAsOf(protocols);
  const traded = cleanTraded(protocols, ref);
  const loo = leaveOneOutStats(traded, ref);
  const model: LaunchModel = {
    coefs: fitOn(traded, ref),
    walkForwardMape: walkForwardStats(traded, ref),
    looMape: loo.mape,
    rmsle: loo.rmsle,
    n: traded.length,
    n_clean: traded.length,
    n_dropped: sortedTraded(protocols).length - traded.length,
  };
  contexts.set(model, { asOf: ref, universe: protocols });
  return model;
}

/** Sort cleaned rows by listing date, fit on the first 75%, score the last 25%. */
function walkForwardStats(traded: SnapshotProtocol[], ref: string): number {
  if (traded.length < 2) return 0;
  const cut = clamp(Math.floor(traded.length * 0.75), 1, traded.length - 1);
  const coefs = fitOn(traded.slice(0, cut), ref);
  return medianApe(coefs, traded.slice(cut), ref);
}

/** The median APE and RMSLE over twelve cleaned rows spread across the market-cap range. */
function leaveOneOutStats(traded: SnapshotProtocol[], ref: string): { mape: number; rmsle: number } {
  const byCap = [...traded].sort((a, b) => (a.mcap_usd ?? 0) - (b.mcap_usd ?? 0) || cmpText(a.slug, b.slug));
  if (byCap.length < 2) return { mape: 0, rmsle: 0 };
  const count = Math.min(12, byCap.length);
  const residuals: number[] = [];
  const errors: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = Math.round((i * (byCap.length - 1)) / (count - 1));
    const heldOut = byCap[at]!;
    const coefs = fitOn(byCap.filter((_, j) => j !== at), ref);
    const r = residual(coefs, heldOut, ref);
    residuals.push(r);
    errors.push(Math.min(1e6, Math.abs(Math.pow(10, r) - 1)));
  }
  return { mape: median(errors), rmsle: rmsleFrom(residuals) };
}

/** Public walk-forward audit: clean first, then score the held-out quarter. */
export function walkForward(protocols: SnapshotProtocol[], asOf?: string): number {
  const ref = asOf ?? referenceAsOf(protocols);
  return walkForwardStats(cleanTraded(protocols, ref), ref);
}

/** Public leave-one-out audit: clean first, then score the sampled rows. */
export function leaveOneOut(protocols: SnapshotProtocol[], asOf?: string): number {
  const ref = asOf ?? referenceAsOf(protocols);
  return leaveOneOutStats(cleanTraded(protocols, ref), ref).mape;
}

/** FNV-1a of the slug, mapped to a fraction under one. */
function slugFraction(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * The probability this category eventually lists, smoothed and blended with the whole universe.
 * `traded` is the universe the odds are measured in: protocols with a market cap are the listed ones.
 */
export function tokenOdds(p: SnapshotProtocol, traded: SnapshotProtocol[]): number {
  const listed = (rows: SnapshotProtocol[]): number => rows.filter((q) => q.mcap_usd !== null && q.mcap_usd > 0).length;
  const global = (listed(traded) + 1) / (traded.length + 2);
  let subset = traded;
  if (p.category !== null) {
    const same = traded.filter((q) => q.category === p.category);
    if (same.length >= 5) subset = same;
  }
  const cat = (listed(subset) + 1) / (subset.length + 2);
  return clamp(0.7 * cat + 0.3 * global, 0.05, 0.95);
}

/** The fitted dollar value of a pre-token protocol, odds-weighted and tie-broken. */
export function impliedValue(p: SnapshotProtocol, model: LaunchModel, asOf?: string): number {
  const context = contexts.get(model);
  const ref = asOf ?? context?.asOf ?? DEFAULT_AS_OF;
  const odds = tokenOdds(p, context?.universe ?? []);
  const tieBreaker = 1 + (slugFraction(p.slug) - 0.5) * 0.006;
  const guess = predict(model.coefs, p, ref) * odds * tieBreaker;
  const whole = Number.isFinite(guess) ? Math.round(guess) : MIN_VALUE;
  return clamp(whole, MIN_VALUE, MAX_VALUE);
}

/** Keep names and chain lists readable inside the dashboard's farm-step strings. */
function short(text: string, max = 36): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/** Centralised venues are farmed through their own points and earn products, not on-chain positions. */
function cexLike(category: string | null): boolean {
  return category !== null && /(cex|cedefi|centrali[sz]ed)/i.test(category);
}

/** Bridging and staking wrappers are the product itself, so a plan must not propose bridging into them. */
function bridgeOrStaking(category: string | null): boolean {
  return category !== null && /(bridge|cross chain|staking|restaking|anchor btc|decentralized btc|restaked btc)/i.test(category);
}

/** Categories with a genuine on-chain provide-liquidity flow. */
function liquidityLike(category: string | null): boolean {
  return category !== null && /(dex|lending|liquidit|farm|yield|allocator|curator|cdp|basis)/i.test(category);
}

/**
 * A concrete farm plan whose shape follows the category: exchange points, on-chain liquidity or a
 * generic deposit-and-monitor flow. The dollar ranges and durations in the steps are the same
 * numbers summarised in the plan's totals; the yield is for a standard $1,000 position.
 */
export function farmPlan(p: SnapshotProtocol, radar: RadarData): FarmPlan {
  const scale = p.tvl_usd >= 1_000_000_000 ? 2 : p.tvl_usd >= 100_000_000 ? 1.5 : 1;
  const exchange = cexLike(p.category);
  const low = exchange ? 50 : Math.round(200 * scale);
  const high = exchange ? 300 : Math.round(500 * scale);
  const step = exchange ? 50 : Math.round(50 * scale);
  const chain = short(p.chains[0] ?? 'its main chain');
  const name = short(p.name);
  const product = short(p.category ?? 'main product', 24);
  const holdDays = ageDays(radar.generated_at_utc, p.listed_at) < 180 ? 60 : 30;
  const weeks = Math.ceil(holdDays / 7);
  const asOf = radar.generated_at_utc;

  let steps: string[];
  if (exchange) {
    steps = [
      `Open ${name}'s official points or loyalty page in a browser (5-10 minutes); note the ${asOf} snapshot and how $${low}-$${high} of volume earns rewards.`,
      `Create and verify a ${name} account (10-20 minutes for KYC), then deposit $${low}-$${high} of USDC by bank transfer; keep the confirmation email and note any deposit fee.`,
      `Put $${low}-$${high} of USDC into ${name}'s own earn or savings product (5-15 minutes); record the quoted APY, any lock-up and the exact dollar amount committed.`,
      `Trade $${step}-$${step * 2} of spot volume each week (10 minutes, under $2 in platform fees) to keep any points multiplier active; do not buy the token on rumours.`,
      `Hold for ${holdDays} days (~${weeks} weeks), then review points and earned interest on ${name}'s rewards page (10-15 minutes) and withdraw the $${low}-$${high} to your bank.`,
      `Log the ${asOf} snapshot, every balance and fee in a sheet (5-10 minutes); recheck after 7 days and stop if the program ends or rewards fall under $1.`,
    ];
  } else if (liquidityLike(p.category) && !bridgeOrStaking(p.category)) {
    steps = [
      `Open a fresh wallet for ${name} on ${chain} and fund it with $${low}-$${high} of ETH or USDC; allow 5-15 minutes and keep the first gas fee under $10.`,
      `Bridge $${low}-$${high} of ETH to ${chain} through its native bridge (5-15 minutes); start with $${step} so gas stays under $10 and check the receiving address.`,
      `Deposit $${low}-$${high} of USDC into ${name}'s ${product} position on ${chain}; budget 10-20 minutes, about $5-15 of gas, and keep the transaction receipt.`,
      `Make one qualifying action each week - a swap, a supply or a vote - with $${step}-$${step * 2} of capital; allow 10 minutes a week and $2-4 in gas.`,
      `Hold for ${holdDays} days, then claim rewards only from ${name}'s official page; set aside 10-15 minutes and $3-8 of gas to close the position.`,
      `Log the ${asOf} snapshot, your entry and every transaction; budget 5-10 minutes and $0-5 of gas to review after 7 days.`,
    ];
  } else {
    steps = [
      `Open a fresh wallet for ${name} and fund it with $${low}-$${high} of USDC (5-15 minutes); confirm ${chain} support on ${name}'s official site before sending funds.`,
      `Deposit $${low}-$${high} of USDC into ${name}'s ${product} on ${chain} (10-20 minutes, about $5-15 gas); start with $${step} and keep the transaction receipt.`,
      `Check the ${name} dashboard once a week (10 minutes): confirm the $${low}-$${high} balance, any reward accrual and that no new approval is needed.`,
      `Hold for ${holdDays} days (~${weeks} weeks), then withdraw the deposit and rewards from ${name}'s official page (10-15 minutes, $3-8 gas) and verify the dollars received.`,
      `Log the ${asOf} snapshot, your entry, weekly checks and final balance (5-10 minutes); review after 7 days and stop if rewards fall below $1.`,
    ];
  }

  const farm_cost_usd = Math.round((low + high) / 2);
  const farm_hours = Math.round((0.25 + 0.25 + 0.3 + weeks * 0.17 + 0.25 + 0.15) * 100) / 100;
  // Estimated daily yield of a $1,000 standard farm: 1000 * (|change_7d| / 100) / 7 * 0.5.
  const churn = Math.abs(finite(p.change_7d, 0)) / 100 / 7;
  const yield_usd_per_day = Math.max(0.1, Math.round(1000 * churn * 0.5 * 100) / 100);
  const verdict: Verdict =
    yield_usd_per_day >= 3 && farm_cost_usd <= 500 ? 'FARM' : yield_usd_per_day >= 0.5 ? 'WATCH' : 'SKIP';
  return { steps, farm_cost_usd, farm_hours, yield_usd_per_day, verdict };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Score and rank every pre-token protocol, then hand back the board and its dashboard dataset. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = fitLaunchValue(snapshot.protocols, snapshot.as_of);
  const watchlist = new Set(snapshot.watchlist);
  const candidates = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) {
    if (p.tvl_usd >= 5_000_000 && p.gecko_id === null && p.symbol === null) candidates.set(p.slug, p);
  }
  let chosen = [...candidates.values()];
  if (chosen.length > 1000) {
    const must = chosen.filter((p) => watchlist.has(p.slug));
    const rest = chosen
      .filter((p) => !watchlist.has(p.slug))
      .sort((a, b) => b.tvl_usd - a.tvl_usd || cmpText(a.slug, b.slug))
      .slice(0, Math.max(0, 1000 - must.length));
    chosen = [...must, ...rest];
  }

  const scored = chosen.map((p) => ({
    p,
    value: impliedValue(p, model, snapshot.as_of),
    odds: tokenOdds(p, snapshot.protocols),
    age: ageDays(snapshot.as_of, p.listed_at),
  }));
  scored.sort((a, b) => b.value - a.value || cmpText(a.p.slug, b.p.slug));

  // A hash tie-breaker is small; this pass guarantees strictly distinct values even after rounding.
  let previous = Number.POSITIVE_INFINITY;
  for (const s of scored) {
    if (s.value >= previous) s.value = Math.max(MIN_VALUE, previous - 1);
    previous = s.value;
  }

  const values = scored.map((s) => s.value);
  const kpi: RadarKpi = {
    watchlist_covered: scored.filter((s) => watchlist.has(s.p.slug)).length,
    watchlist_total: snapshot.watchlist.length,
    rows: scored.length,
    traded_n: model.n,
    walkforward_mape: model.walkForwardMape,
    loo_mape: model.looMape,
    rmsle: model.rmsle,
    n_clean: model.n_clean,
    n_dropped: model.n_dropped,
    min_value: values.length > 0 ? Math.min(...values) : 0,
    max_value: values.length > 0 ? Math.max(...values) : 0,
    distinct_values: new Set(values).size,
  };
  const stub: RadarData = { rows: [], kpi, generated_at_utc: snapshot.as_of, model_coefs: model.coefs };
  const board: BoardRow[] = scored.map((s, i) => {
    const plan = farmPlan(s.p, stub);
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: s.value,
      on_watchlist: watchlist.has(s.p.slug),
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      token_odds: s.odds,
      farm_steps: plan.steps,
      farm_cost_usd: plan.farm_cost_usd,
      farm_hours: plan.farm_hours,
      yield_usd_per_day: plan.yield_usd_per_day,
      verdict: plan.verdict,
      mape_walkforward: model.walkForwardMape,
      mape_loo: model.looMape,
      rmsle: model.rmsle,
      n_clean: model.n_clean,
      n_dropped: model.n_dropped,
    };
  });
  return {
    board,
    radar: { rows: board, kpi, generated_at_utc: snapshot.as_of, model_coefs: model.coefs },
  };
}

/** The exact gate rules, or null when the board is one the gate will take. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows; the gate wants 100-4000`;
  const ranks = new Set<number>();
  for (let i = 0; i < board.length; i++) {
    const rank = board[i]?.rank;
    if (rank !== i + 1 || ranks.has(rank as number)) return `row ${i + 1} has rank ${String(rank)}`;
    ranks.add(rank as number);
  }
  for (let i = 1; i < board.length; i++) {
    const now = board[i]?.implied_value_usd ?? 0;
    const before = board[i - 1]?.implied_value_usd ?? 0;
    if (now > before) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `unknown slug ${r.slug}`;
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    const steps = r.farm_steps;
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) return `${r.slug} has ${Array.isArray(steps) ? steps.length : 0} farm steps`;
    for (const s of steps) {
      if (typeof s !== 'string') return `${r.slug} has a non-string farm step`;
      const length = s.trim().length;
      if (length < 20 || length > 600) return `${r.slug} has a farm step of ${length} characters`;
    }
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'every row shares one implied value';
  return null;
}

/** The dashboard dataset as one offline script. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
