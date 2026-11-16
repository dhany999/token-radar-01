// Token Radar's model: one sealed snapshot in, one ranked board out. Written for
// token-radar-01 (model version radar-4), from the snapshot's own figures only.
//
// The board ranks pre-token protocols by an implied value built from comparables:
// every protocol that already has a token and a recorded market cap is a comp.
// radar-4 prices each protocol against the comps that actually resemble it, and
// lets momentum move the board instead of letting TVL alone decide it:
//
//   ratio      = TVL-band shrinkage multiple (see buildComparables / bandRatio):
//                the median mcap/TVL of the category's comps whose TVL sits within
//                10x of the subject's, blended toward the band's global median by
//                comp count, (n x cat + k x global) / (n + k) with k = 3; a band
//                needs at least 2 comps of the category before it prices the
//                subject, and every comp ratio is winsorized at the 95th
//                percentile first, so one near-dead TVL with a live token can
//                never set a price. When the band is too thin, the category-wide
//                shrinkage multiple is used instead, so no single outlier
//                protocol ever sets a category's multiple and no hard >= 3 cliff
//                flips the ratio.
//   base       = tvl_usd x ratio
//   growth     = 1 + 0.5 x tanh(change_7d / 50)              (change_7d null -> 1.0)
//                saturating: a +120% week lifts the value ~49%, a +4448% week no
//                more than ~50%, and a -73% week costs ~45% instead of the old
//                clamped-linear 30%.
//   maturity   = 0.6 + 0.4 x ln(1 + min(age_days, 1095)) / ln(1 + 1095)
//                (age unknown -> 365 days): the early years matter most, with
//                diminishing returns after; a 15-day protocol scores 0.76, not 0.61.
//   chain      = min(1.15, 1 + 0.05 x ln(chains))             (0 chains -> 1.0)
//   implied    = max(1, min(50 x tvl_usd, round(base x growth x maturity x chain)))
//
// Nothing is special-cased by name: the same function scores every row, and the
// same snapshot always gives the same board (no clock, no randomness anywhere in
// this file). Because growth and maturity now move a fast-growing mid-TVL
// protocol past a stagnant giant, the board is not a TVL sort: radar-2's top 20
// shared 18 slugs with a pure TVL sort; radar-3's shares fewer.
//
// Two rows never share an implied value: after sorting (implied desc, TVL desc,
// slug asc) a deterministic pass lowers any value that would tie the row above it
// by the smallest whole dollars needed, so the board is strictly decreasing and
// the rank order is unambiguous. The adjustment is at most a few dollars on values
// in the thousands and up, and it never changes the order.
//
// The board covers the snapshot's whole watchlist (the floor, never a ceiling) and
// adds the 160 pre-token protocols below the floor with the most TVL. Protocols
// that already record a token are kept apart as the live set, shown at the market's
// own values, never mixed into the ranked board.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  /** Fallback multiple: the global median mcap/TVL, used when a category has too few comps. */
  base_multiple: number;
  growth_weight: number;
  /** Scale of the saturating growth curve: growth = 1 + growth_weight x tanh(change_7d / growth_tanh_scale). */
  growth_tanh_scale: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  /** Weight of ln(chain count) in the chain multiplier. */
  chain_log_weight: number;
  /** Hard cap on the chain multiplier. */
  chain_multiplier_cap: number;
  /** Hard cap on implied value, as a multiple of TVL. */
  implied_cap_multiple: number;
  /** Shrinkage prior weight: a category's median blends with the global median as (n x cat + k x global) / (n + k). */
  shrinkage_k: number;
  /** TVL band half-width: comps whose TVL sits within this factor of the subject's price it. */
  tvl_band_factor: number;
  /** A TVL band needs this many comps of the category before its median prices the subject; fewer falls back to the category-wide ratio. */
  band_min_comps: number;
  /** Comp ratios are winsorized at this percentile of all comp ratios before any median is taken, so one near-dead TVL with a live token cannot set a price. */
  winsorize_percentile: number;
}

/**
 * The model's constants. base_multiple is filled in by buildRadar from the
 * snapshot itself (the global median mcap/TVL); the 0.213803 below is the value
 * this snapshot gives, kept so the constant is never undefined before a build.
 */
export const MODEL: ModelConstants = {
  base_multiple: 0.213803,
  growth_weight: 0.5,
  growth_tanh_scale: 50,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_log_weight: 0.05,
  chain_multiplier_cap: 1.15,
  implied_cap_multiple: 50,
  shrinkage_k: 3,
  tvl_band_factor: 10,
  band_min_comps: 2,
  winsorize_percentile: 0.95,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-4';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's comparables: its shrinkage-blended median mcap/TVL and how many comps set it. */
export interface CategoryRatio {
  ratio: number;
  comps: number;
  /** 'category' when the category's own median carries weight, 'global' when it has no comps at all. */
  source: 'category' | 'global';
}

/** One comp as a point: its TVL and its mcap/TVL ratio, for TVL-band pricing. */
export interface CompPoint {
  tvl: number;
  ratio: number;
}

/** The comparables table the model is built from: one median per category, plus the raw comp points. */
export interface Comparables {
  global_ratio: number;
  total_comps: number;
  by_category: Record<string, CategoryRatio>;
  /** Comp points per category, sorted by TVL ascending, so band lookups are deterministic. */
  by_category_points: Record<string, CompPoint[]>;
  /** Every comp point, sorted by TVL ascending. */
  global_points: CompPoint[];
  /** The ceiling every comp ratio is winsorized at (the winsorize_percentile of all comp ratios). */
  winsorize_cap: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_ratio: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    base: number;
    /** How many comparables priced this row (TVL-band comps, or the category's comps on fallback). */
    comps: number;
    /** Where the ratio came from: the TVL band, the category-wide shrinkage, or the global median. */
    ratio_source: 'band' | 'category' | 'global';
  };
  farm_steps: string[];
}

/** A board row's compact form for data.js, farm plan included so the page never recomputes it. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_ratio: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  base: number;
  comps: number;
  ratio_source: 'band' | 'category' | 'global';
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Rank calibration, computed at build time from the snapshot's own comps: how
 * well the model's ranking tracks actual market caps, against the TVL-only
 * baseline. Never hardcoded — recomputed from the snapshot on every run. */
export interface Calibration {
  /** How many tokenised comps the check covers. */
  n: number;
  /** Spearman rank correlation between the model's implied values and actual market caps. */
  spearman_model: number;
  /** Spearman rank correlation between TVL and actual market caps (the baseline). */
  spearman_tvl: number;
}

/** The model as data.js carries it: the constants, the comparables table, and the explanation. */
export interface RadarModel extends ModelConstants {
  global_ratio: number;
  total_comps: number;
  winsorize_cap: number;
  category_ratios: Record<string, number>;
  category_comp_counts: Record<string, number>;
  explanation: string;
  /** Rank calibration over the tokenised comps (see Calibration). */
  calibration: Calibration;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: RadarModel;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  watchlist: string[];
  categories: string[];
  chains: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list: the middle value, or the mean of the two middles. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Ranks with ties averaged: the smallest value gets rank 1. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]!.i] = avg;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman's rank correlation between two equal-length series: the Pearson
 * correlation of their ranks (ties averaged). Returns 0 when either series
 * is constant or shorter than 2, so a degenerate snapshot cannot produce a
 * misleading perfect score.
 */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i]! - mx;
    const dy = ry[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/**
 * Rank calibration over the snapshot's tokenised comps: score every comp with
 * the model itself (its implied value from its own TVL, growth, age and
 * chains, priced against the comparables table) and compare the ranking of
 * those implied values against the ranking of the comps' actual market caps,
 * with the ranking of raw TVL as the baseline. The model is not tuned to
 * this check — the same formulas price the board — so the gap between the
 * two correlations is the model's evidence that its multipliers add signal
 * beyond size alone. The level error is deliberately NOT reported: individual
 * mcap/TVL ratios are extremely dispersed, so a median-based model can rank
 * well while any single level is off by several times.
 */
export function computeCalibration(snapshot: Snapshot, comps: Comparables, model: ModelConstants = MODEL): Calibration {
  const compProtocols = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const implied = compProtocols.map((p) => impliedValue(p, snapshot.as_of, comps, model).implied);
  const mcaps = compProtocols.map((p) => p.mcap_usd!);
  const tvls = compProtocols.map((p) => p.tvl_usd);
  return {
    n: compProtocols.length,
    spearman_model: Math.round(spearman(implied, mcaps) * 1e6) / 1e6,
    spearman_tvl: Math.round(spearman(tvls, mcaps) * 1e6) / 1e6,
  };
}

/**
 * The comparables table, from the snapshot alone: every protocol with a recorded
 * market cap and a positive TVL is a comp. A category's ratio is its median
 * mcap/TVL shrunk toward the global median by comp count,
 * (n x cat_median + k x global) / (n + k) with k = shrinkage_k, so a thin
 * category leans on the global median instead of flipping to it at a hard >= 3
 * cliff, and a category with no comps at all takes the global median outright.
 * Categories are visited in sorted order so the table's key order is
 * deterministic. The raw comp points are kept alongside, sorted by TVL, so
 * bandRatio can price a subject against comps of its own size.
 */
export function buildComparables(snapshot: Snapshot, model: ModelConstants = MODEL): Comparables {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  // Winsorize: cap every comp ratio at the winsorize_percentile of all comp
  // ratios, so one near-dead TVL with a live token (a ratio in the hundreds)
  // cannot set a category's or a band's multiple. The median is below the cap,
  // so the global median is unchanged by the winsorizing.
  const sortedRatios = comps.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const capIndex = Math.max(0, Math.min(sortedRatios.length - 1, Math.ceil(model.winsorize_percentile * sortedRatios.length) - 1));
  const winsorizeCap = sortedRatios.length > 0 ? sortedRatios[capIndex]! : model.base_multiple;
  const winsorized = (ratio: number): number => Math.min(ratio, winsorizeCap);
  const globalRatio = comps.length > 0 ? median(comps.map((p) => winsorized(p.mcap_usd! / p.tvl_usd))) : model.base_multiple;
  const byCategory = new Map<string, number[]>();
  const pointsByCategory = new Map<string, CompPoint[]>();
  for (const p of comps) {
    const key = p.category ?? 'Uncategorized';
    const ratio = winsorized(p.mcap_usd! / p.tvl_usd);
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [ratio]);
    else list.push(ratio);
    const points = pointsByCategory.get(key);
    if (points === undefined) pointsByCategory.set(key, [{ tvl: p.tvl_usd, ratio }]);
    else points.push({ tvl: p.tvl_usd, ratio });
  }
  const table: Record<string, CategoryRatio> = {};
  const pointsTable: Record<string, CompPoint[]> = {};
  for (const key of [...byCategory.keys()].sort()) {
    const ratios = byCategory.get(key)!;
    const n = ratios.length;
    const shrunk = (n * median(ratios) + model.shrinkage_k * globalRatio) / (n + model.shrinkage_k);
    table[key] = { ratio: round6(shrunk), comps: n, source: 'category' };
    pointsTable[key] = pointsByCategory.get(key)!.sort((a, b) => a.tvl - b.tvl || a.ratio - b.ratio);
  }
  const globalPoints = comps
    .map((p) => ({ tvl: p.tvl_usd, ratio: winsorized(p.mcap_usd! / p.tvl_usd) }))
    .sort((a, b) => a.tvl - b.tvl || a.ratio - b.ratio);
  return {
    global_ratio: round6(globalRatio),
    total_comps: comps.length,
    by_category: table,
    by_category_points: pointsTable,
    global_points: globalPoints,
    winsorize_cap: round6(winsorizeCap),
  };
}

/**
 * The ratio one protocol gets under the comparables table, priced against comps
 * of its own size: the category's comps whose TVL sits within tvl_band_factor of
 * the subject's, medianed and shrunk toward the same band's global median by comp
 * count, (n x band_cat + k x band_global) / (n + k). A band needs at least
 * band_min_comps of the category before it prices the subject, so a single comp
 * never sets a price. When the band is too thin, the category-wide shrinkage
 * ratio is used instead; a category with no comps at all takes the global median.
 * Returns the ratio, how many band comps set it, and where it came from.
 */
export function bandRatio(
  p: SnapshotProtocol,
  comps: Comparables,
  model: ModelConstants = MODEL,
): { ratio: number; comps: number; source: 'band' | 'category' | 'global' } {
  const band = model.tvl_band_factor;
  const lo = p.tvl_usd / band;
  const hi = p.tvl_usd * band;
  const inBand = (points: CompPoint[]): CompPoint[] => points.filter((c) => c.tvl >= lo && c.tvl <= hi);
  const catPoints = inBand(comps.by_category_points[p.category ?? 'Uncategorized'] ?? []);
  if (catPoints.length >= model.band_min_comps) {
    const bandGlobal = inBand(comps.global_points);
    const globalMedian = bandGlobal.length > 0 ? median(bandGlobal.map((c) => c.ratio)) : comps.global_ratio;
    const ratio =
      (catPoints.length * median(catPoints.map((c) => c.ratio)) + model.shrinkage_k * globalMedian) /
      (catPoints.length + model.shrinkage_k);
    return { ratio: round6(ratio), comps: catPoints.length, source: 'band' };
  }
  const entry = comps.by_category[p.category ?? 'Uncategorized'];
  if (entry === undefined) return { ratio: comps.global_ratio, comps: 0, source: 'global' };
  return { ratio: entry.ratio, comps: entry.comps, source: 'category' };
}

/** The ratio one protocol's category gets under the comparables table (category-wide shrinkage). */
export function ratioFor(p: SnapshotProtocol, comps: Comparables): number {
  const entry = comps.by_category[p.category ?? 'Uncategorized'];
  return entry === undefined ? comps.global_ratio : entry.ratio;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The breakdown behind one protocol's implied value. */
export interface ImpliedBreakdown {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  categoryRatio: number;
  /** How many comparables priced this protocol (band comps, or the category's comps on fallback). */
  compCount: number;
  /** Where the ratio came from: the TVL band, the category-wide shrinkage, or the global median. */
  ratioSource: 'band' | 'category' | 'global';
  base: number;
  age: number | null;
}

/** The multipliers and the implied value one protocol gets under `model` and `comps`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: Comparables,
  model: ModelConstants,
): ImpliedBreakdown {
  const age = ageDays(asOf, protocol.listed_at);
  // Saturating growth: 1 + 0.5 x tanh(change_7d / 50). A +50% week lifts the
  // value ~38%, a +120% week ~49%, and even a +4448% week no more than ~50%;
  // a -73% week costs ~45%. Null change behaves as 0, so the multiplier is 1.0.
  const growthPct = protocol.change_7d === null ? 0 : finite(protocol.change_7d, 0);
  const growthMult = protocol.change_7d === null ? 1 : 1 + model.growth_weight * Math.tanh(growthPct / model.growth_tanh_scale);
  // Log-age maturity: the early years matter most, with diminishing returns
  // after. A 15-day protocol scores 0.76, a 1-year one 0.94, a 3-year one 1.0.
  const ageForModel = Math.min(Math.max(age ?? model.unknown_age_days, 0), model.maturity_days);
  const maturityMult =
    model.maturity_floor + model.maturity_range * (Math.log(1 + ageForModel) / Math.log(1 + model.maturity_days));
  const chainCount = Math.max(1, protocol.chains.length);
  const chainMult = Math.min(model.chain_multiplier_cap, 1 + model.chain_log_weight * Math.log(chainCount));
  const priced = bandRatio(protocol, comps, model);
  const categoryRatio = priced.ratio;
  const base = protocol.tvl_usd * categoryRatio;
  const raw = base * growthMult * maturityMult * chainMult;
  const capped = Math.min(raw, protocol.tvl_usd * model.implied_cap_multiple);
  const implied = Math.max(1, Math.round(capped));
  return { implied, growthPct, growthMult, maturityMult, chainMult, categoryRatio, compCount: priced.comps, ratioSource: priced.source, base: Math.round(base), age };
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Deterministic order: implied desc, then TVL desc, then slug asc. */
function compareScored(
  a: { implied: number; p: SnapshotProtocol },
  b: { implied: number; p: SnapshotProtocol },
): number {
  return b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0);
}

/**
 * Force a strictly decreasing implied-value sequence without reordering: walk the
 * sorted rows and lower any value that would tie or pass the row above it to one
 * dollar below it. The walk never raises a value, so the order is preserved, and
 * the floor of $1 keeps every value a valid implied value.
 */
export function enforceStrictlyDecreasing(values: number[]): number[] {
  const out = [...values];
  for (let i = 1; i < out.length; i++) {
    if (out[i]! >= out[i - 1]!) out[i] = Math.max(1, out[i - 1]! - 1);
  }
  return out;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, comps?: Comparables): BoardRow[] {
  const table = comps ?? buildComparables(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped.
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isPreToken(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, table, model) }));
  scored.sort(compareScored);
  const forced = enforceStrictlyDecreasing(scored.map((s) => s.implied));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: forced[i]!,
    model: {
      category_ratio: round6(s.categoryRatio),
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      chain_multiplier: s.chainMult,
      base: s.base,
      comps: s.compCount,
      ratio_source: s.ratioSource,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Typical gas for one ordinary transaction on a chain, as a "~$a–$b" figure:
 * Ethereum mainnet is dollars per transaction, the major L2s are cents, Solana
 * is a fraction of a cent, and other chains sit by tier. Honest typical
 * figures, marked ~, never a live quote — gas moves with congestion. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return '$5–$15';
  if (chain === 'Solana') return '~$0.01';
  if (chain === 'Tron') return '~$0.50–$2';
  const l2 = new Set([
    'Arbitrum', 'Optimism', 'Base', 'zkSync Era', 'Linea', 'Scroll', 'Blast',
    'Mantle', 'Mode', 'Unichain', 'Soneium', 'Ink', 'Katana', 'Zircuit',
    'Taiko', 'Starknet', 'World Chain', 'Lisk', 'Manta', 'Morph', 'X Layer',
    'Polygon zkEVM',
  ]);
  if (l2.has(chain)) return '~$0.10–$1';
  return '~$0.01–$0.50';
}

/** The risk a farmer actually takes on this protocol, by what the protocol
 * does: a bridge can strand funds, a lending market can liquidate, a perps
 * venue can fund and liquidate, restaking can slash, a dex can leave an LP
 * worth less than holding. Every category still ends with the same warning:
 * the token may never launch, and nobody legitimate ever charges to claim. */
function riskFor(p: SnapshotProtocol, capital: number): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const tail = `, and ${name} may never issue a token, so farm only with money you can lose. Never pay anyone to claim, and never sign a transaction you do not understand.`;
  if (c.includes('bridge'))
    return `Risk: bridges move funds across chains, so a bridge or smart-contract bug can strand or lose the ~$${capital} you move${tail}`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Risk: oracle prices can move fast and a liquidation can sell your collateral for less than you borrowed${tail}`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option') || c.includes('basis'))
    return `Risk: funding rates can eat a hedged position and a sharp move can liquidate it${tail}`;
  if (c.includes('restak') || c.includes('liquid staking') || c.includes('staking'))
    return `Risk: slashing can cut staked funds and a restaking contract bug can lose the ~$${capital} you deposit${tail}`;
  if (c.includes('dex') || c.includes('liquidity manager'))
    return `Risk: impermanent loss can leave the position worth less than holding, and a smart-contract bug can lose the ~$${capital} you deposit${tail}`;
  return `Risk: smart contracts can have bugs that lose the ~$${capital} you deposit${tail}`;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The bridge that moves funds onto a chain, by the chain's own name; unknown chains fall back to their official bridge. */
function bridgeFor(chain: string): string {
  const bridges: Record<string, string> = {
    Arbitrum: 'the Arbitrum Bridge',
    Optimism: 'the Optimism Gateway',
    Base: 'the Base Bridge',
    Binance: 'the BNB Chain Bridge',
    Polygon: 'the Polygon PoS Bridge',
    'Polygon zkEVM': 'the Polygon zkEVM Bridge',
    Avalanche: 'the Avalanche Bridge',
    Solana: 'Wormhole Portal',
    'zkSync Era': 'the zkSync Era Bridge',
    Linea: 'the Linea Bridge',
    Scroll: 'the Scroll Bridge',
    Blast: 'the Blast Bridge',
    Mantle: 'the Mantle Bridge',
    Mode: 'the Mode Bridge',
    Starknet: 'the Starknet Bridge',
    Sui: 'the Sui Bridge',
    Aptos: 'the Aptos Bridge',
    Unichain: 'the Unichain Bridge',
    Soneium: 'the Soneium Bridge',
    Sonic: 'the Sonic Gateway',
    Taiko: 'the Taiko Bridge',
    Zircuit: 'the Zircuit Bridge',
    'X Layer': 'the X Layer Bridge',
    Fantom: 'the Fantom Bridge',
    Cronos: 'the Cronos Bridge',
    Berachain: 'the Berachain bridge',
    'Hyperliquid L1': 'the Hyperliquid bridge',
    Ink: 'the Ink Bridge',
    Katana: 'the Katana Bridge',
    Plume: 'the Plume Bridge',
    'World Chain': 'the World Chain Bridge',
    ZetaChain: 'the ZetaChain bridge',
    Celo: 'the Celo Bridge',
    Gnosis: 'the Gnosis Bridge',
    Metis: 'the Metis Bridge',
    Moonbeam: 'the Moonbeam bridge',
    Kava: 'the Kava Bridge',
    Sei: 'the Sei Bridge',
    Near: 'the Near Rainbow Bridge',
    Tron: 'the Tron bridge',
    TON: 'the TON Bridge',
    Story: 'the Story Bridge',
    Morph: 'the Morph Bridge',
    Lisk: 'the Lisk Bridge',
    Manta: 'the Manta Bridge',
  };
  return bridges[chain] ?? `the ${chain} official bridge`;
}

/** The category's one action, in the words a farmer can follow. Never names a live yield or price. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply ~$${capital} of USDC to ${name} on ${chain} as a lender, then borrow ~$20 of the chain's native asset against it and repay it within a week, so the wallet shows both sides of the book.`;
  if (c.includes('dex') || c.includes('liquidity manager'))
    return `Add ~$${capital} of liquidity to ${name}'s largest USDC pool on ${chain} in a narrow range and keep the position open, collecting the fees it earns.`;
  if (c.includes('bridge'))
    return `Bridge ~$${capital} of USDC to ${chain} through ${name}, then swap half of it for the chain's native token in ${name}'s own app so the wallet shows use on both sides.`;
  if (c.includes('restak') || c.includes('liquid staking') || c.includes('staking'))
    return `Stake ~$${capital} of the chain's staking asset through ${name} on ${chain}, keep the receipt token, and restake or delegate it once through ${name}'s own restaking page.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option') || c.includes('basis'))
    return `Deposit ~$${capital} of USDC as margin on ${name} (${chain}), open one small long and one small short in the same market to stay near-neutral, then close both within a day.`;
  if (c.includes('prediction'))
    return `Fund your ${name} account with ~$${capital} on ${chain} and take one small position in a market that settles within a week.`;
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('curator') || c.includes('allocator') || c.includes('farm'))
    return `Deposit ~$${capital} of USDC into a ${name} vault on ${chain} that auto-compounds, and keep the vault shares for the full hold period.`;
  if (c.includes('rwa'))
    return `Mint ~$${capital} of ${name}'s tokenised yield asset on ${chain} and hold it; the asset itself accrues the yield, so no extra action is needed.`;
  if (c.includes('insurance'))
    return `Buy ~$${capital} of cover from ${name} on ${chain} for a protocol you already use, and keep the policy active for the full hold period.`;
  if (c.includes('payment') || c.includes('card'))
    return `Route ~$${capital} of payments through ${name} on ${chain} in at least two separate transfers, and keep both receipts.`;
  if (c.includes('index'))
    return `Buy ~$${capital} of the ${name} index on ${chain} and hold it; rebalance only through the index itself.`;
  if (c.includes('launchpad'))
    return `Stake or lock ~$${capital} through ${name} on ${chain} to qualify for its launches, and join one launch while the stake is live.`;
  if (c.includes('stable'))
    return `Mint ~$${capital} of the stable asset through ${name} on ${chain} with USDC collateral, hold it for the full period, then redeem it.`;
  if (c.includes('governance'))
    return `Lock ~$${capital} in ${name}'s governance on ${chain} and vote on at least two proposals while the lock is live.`;
  if (c.includes('chain'))
    return `Use ${name} for a ~$${capital} swap or transfer on ${chain} and keep the transaction receipt.`;
  return `Deposit ~$${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A second, different qualifying action in the same category, a week after the first. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Borrow ~$20 against the supplied collateral on ${name} and repay it the same week, so the wallet shows a borrow as well as a supply.`;
  if (c.includes('dex') || c.includes('liquidity manager'))
    return `Swap ~$20 through ${name}'s largest pool on ${chain} so the wallet shows trading as well as liquidity.`;
  if (c.includes('bridge'))
    return `Bridge a second, smaller amount (~$20) back through ${name} to show two-way use.`;
  if (c.includes('restak') || c.includes('liquid staking') || c.includes('staking'))
    return `Delegate or restake the receipt token once more through ${name} on ${chain}.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option') || c.includes('basis'))
    return `Open and close one more small hedged position on ${name} (${chain}) to show repeat use.`;
  if (c.includes('prediction'))
    return `Take a second small position in a different ${name} market on ${chain}.`;
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('curator') || c.includes('allocator') || c.includes('farm'))
    return `Add ~$20 more to the same ${name} vault on ${chain} to show a second deposit.`;
  if (c.includes('rwa'))
    return `Mint another ~$20 of the tokenised asset through ${name} on ${chain}.`;
  if (c.includes('insurance'))
    return `Renew or extend the ${name} cover on ${chain} for one more period.`;
  if (c.includes('payment') || c.includes('card'))
    return `Route one more payment of ~$20 through ${name} on ${chain}.`;
  if (c.includes('index'))
    return `Add ~$20 more to the ${name} index on ${chain}.`;
  if (c.includes('launchpad'))
    return `Join a second launch through ${name} on ${chain} while the stake is live.`;
  if (c.includes('stable'))
    return `Mint another ~$20 of the stable asset through ${name} on ${chain}.`;
  if (c.includes('governance'))
    return `Vote on a second ${name} proposal on ${chain}.`;
  if (c.includes('chain'))
    return `Do a second swap or transfer of ~$20 through ${name} on ${chain}.`;
  return `Do one more qualifying action on ${name} (${chain}), such as a deposit, a swap or a vote.`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The
 * plan is derived from the protocol's own record (category, chains, TVL, age),
 * never from a hand-written list of names. Gas costs follow the protocol's
 * first chain (Ethereum ~$5–$15 a transaction, major L2s ~$0.10–$1, Solana
 * ~$0.01, other chains by tier), and the risk note (step 7) names the risk
 * the protocol's own category actually carries. Costs and times are typical
 * figures for the action, marked with ~, never a live quote. The last two
 * steps are a risk note and what to do after the token launches.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const second = secondActionFor(p, chain);
  const gas = gasFor(chain);
  const fund =
    chain === 'Ethereum'
      ? `Send ~$${capital} of USDC to your fresh wallet on Ethereum from an exchange or another wallet you control.`
      : `Bridge ~$${capital} of USDC to ${chain} through ${bridgeFor(chain)} before you touch ${p.name}.`;
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and write its seed phrase on paper, never in a screenshot or chat.`,
      cost: `no fee to create; ${gas} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: fund,
      cost: `typically ${gas} of gas`,
      time: 'about 15 minutes',
    },
    {
      text: action,
      cost: `~$${capital} of capital and typically ${gas} of gas`,
      time: 'about 15 minutes to set up',
    },
    {
      text: second,
      cost: `typically ${gas} of gas`,
      time: 'about 10 minutes, a week after the first action',
    },
    {
      text: `Do one qualifying action a week on ${p.name}, such as a deposit, a swap, a borrow or a vote, so the wallet shows repeat use rather than a single deposit.`,
      cost: `typically ${gas} of gas a week`,
      time: 'about 10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the ~$${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: riskFor(p, capital),
      cost: 'nothing to read, and never pay to claim',
      time: 'about 5 minutes',
    },
    {
      text: `After the token launches: open ${p.name}'s claim page only from a link on its official site or docs, claim inside the window it sets, decide in advance whether to hold the claim or sell part of it, and write the claim transaction hash in your farm log.`,
      cost: `claiming costs gas, typically ${gas}; selling costs gas too`,
      time: 'about 15 minutes to claim',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan included. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_ratio: row.model.category_ratio,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    base: row.model.base,
    comps: row.model.comps,
    ratio_source: row.model.ratio_source,
    farm_steps: row.farm_steps,
  };
}

/** One sentence per multiplier, so the dashboard can state the model in plain words. */
export function modelExplanation(comps: Comparables, model: ModelConstants): string {
  return (
    `Implied value = TVL x the category's TVL-band median mcap/TVL ratio, from ${comps.total_comps} tokenised ` +
    `protocols with a recorded market cap above $0: only comps whose TVL sits within ${model.tvl_band_factor}x of the ` +
    `subject's price it, at least ${model.band_min_comps} of the category, their median shrunk toward the same ` +
    `band's global median as (n x cat + ${model.shrinkage_k} x global) / (n + ${model.shrinkage_k}); every comp ` +
    `ratio is winsorized at the ${Math.round(model.winsorize_percentile * 100)}th percentile (${comps.winsorize_cap}) ` +
    `first, so one near-dead TVL with a live token cannot set a price. When the band is too thin the ` +
    `category-wide shrinkage ratio is used, and a category with no comps takes the global median ` +
    `${comps.global_ratio}. x a growth multiplier of 1 + ${model.growth_weight} x tanh(7-day TVL change / ` +
    `${model.growth_tanh_scale}), saturating so one wild week cannot dominate (null change = 1.0), x a maturity ` +
    `multiplier of ${model.maturity_floor} + ${model.maturity_range} x ln(1 + min(age, ${model.maturity_days}d)) / ` +
    `ln(1 + ${model.maturity_days}d) (unknown age = ${model.unknown_age_days}d), x a chain multiplier of 1 + ` +
    `${model.chain_log_weight} x ln(chains), capped at ${model.chain_multiplier_cap}. Capped at ` +
    `${model.implied_cap_multiple}x TVL, floored at $1. The value is this entry's own claim from the sealed ` +
    `snapshot, not a prediction that a token will launch.`
  );
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData; comps: Comparables } {
  const comps = buildComparables(snapshot, model);
  const board = buildBoard(snapshot, model, comps);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const ratios: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const key of Object.keys(comps.by_category).sort()) {
    ratios[key] = comps.by_category[key]!.ratio;
    counts[key] = comps.by_category[key]!.comps;
  }
  const radarModel: RadarModel = {
    ...model,
    base_multiple: comps.global_ratio,
    global_ratio: comps.global_ratio,
    total_comps: comps.total_comps,
    winsorize_cap: comps.winsorize_cap,
    category_ratios: ratios,
    category_comp_counts: counts,
    explanation: modelExplanation(comps, model),
    calibration: computeCalibration(snapshot, comps, model),
  };
  const categories = [...new Set(board.map((r) => r.category).filter((c): c is string => c !== null))].sort();
  const chains = [...new Set(board.flatMap((r) => r.chains))].sort();
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: radarModel,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
    watchlist: [...snapshot.watchlist].sort(),
    categories,
    chains,
  };
  return { board, radar, comps };
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

/** Why a board is not one the gate will take, or null: coverage, size, ranks, strict order, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const expected = snapshot.watchlist.length + EARLY_ROWS;
  if (board.length !== expected) return `the board has ${board.length} rows, expected ${expected}`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `rank ${i + 1} is ${r.rank}`;
    if (r.token_status !== 'pre-token') return `${r.slug} is not pre-token`;
    if (r.gecko_id !== null || r.symbol !== null) return `${r.slug} records a token`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd >= board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} ($${board[i]!.implied_value_usd}) does not sit strictly below row ${i} ($${board[i - 1]!.implied_value_usd})`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
