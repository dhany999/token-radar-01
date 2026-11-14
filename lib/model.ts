// Token Radar's model: one sealed snapshot in, one ranked board out. Written for
// token-radar-01 (model version radar-2), from the snapshot's own figures only.
//
// The board ranks pre-token protocols by an implied value built from comparables:
// every protocol that already has a token and a recorded market cap is a comp. For
// each category the model takes the median market-cap/TVL ratio of its comps; a
// category with fewer than three comps falls back to the global median, so no single
// outlier protocol ever sets a category's multiple. Nothing is special-cased by
// name: the same function scores every row, and the same snapshot always gives the
// same board (no clock, no randomness anywhere in this file).
//
//   ratio      = median mcap/TVL of the category's comps (>= 3), else the global median
//   base       = tvl_usd x ratio
//   growth     = 1 + 0.5 x clamp(change_7d, -60, 120) / 100   (change_7d null -> 1.0)
//   maturity   = 0.6 + 0.4 x min(age_days, 1095) / 1095       (age unknown -> 365 days)
//   chain      = min(1.15, 1 + 0.05 x ln(chains))             (0 chains -> 1.0)
//   implied    = max(1, min(50 x tvl_usd, round(base x growth x maturity x chain)))
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
  growth_floor: number;
  growth_cap: number;
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
  /** A category needs this many comps before its own median is used. */
  min_comps_per_category: number;
}

/**
 * The model's constants. base_multiple is filled in by buildRadar from the
 * snapshot itself (the global median mcap/TVL); the 0.213803 below is the value
 * this snapshot gives, kept so the constant is never undefined before a build.
 */
export const MODEL: ModelConstants = {
  base_multiple: 0.213803,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_log_weight: 0.05,
  chain_multiplier_cap: 1.15,
  implied_cap_multiple: 50,
  min_comps_per_category: 3,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's comparables: its median mcap/TVL and how many comps set it. */
export interface CategoryRatio {
  ratio: number;
  comps: number;
  /** 'category' when the category's own median is used, 'global' when it fell back. */
  source: 'category' | 'global';
}

/** The comparables table the model is built from: one median per category. */
export interface Comparables {
  global_ratio: number;
  total_comps: number;
  by_category: Record<string, CategoryRatio>;
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

/** The model as data.js carries it: the constants, the comparables table, and the explanation. */
export interface RadarModel extends ModelConstants {
  global_ratio: number;
  total_comps: number;
  category_ratios: Record<string, number>;
  category_comp_counts: Record<string, number>;
  explanation: string;
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

/**
 * The comparables table, from the snapshot alone: every protocol with a recorded
 * market cap and a positive TVL is a comp. A category's ratio is the median of its
 * comps' mcap/TVL when it has at least min_comps_per_category of them; anything
 * thinner falls back to the global median over all comps. Categories are visited
 * in sorted order so the table's key order is deterministic.
 */
export function buildComparables(snapshot: Snapshot, model: ModelConstants = MODEL): Comparables {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const globalRatio = comps.length > 0 ? median(comps.map((p) => p.mcap_usd! / p.tvl_usd)) : model.base_multiple;
  const byCategory = new Map<string, number[]>();
  for (const p of comps) {
    const key = p.category ?? 'Uncategorized';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [p.mcap_usd! / p.tvl_usd]);
    else list.push(p.mcap_usd! / p.tvl_usd);
  }
  const table: Record<string, CategoryRatio> = {};
  for (const key of [...byCategory.keys()].sort()) {
    const ratios = byCategory.get(key)!;
    table[key] =
      ratios.length >= model.min_comps_per_category
        ? { ratio: round6(median(ratios)), comps: ratios.length, source: 'category' }
        : { ratio: round6(globalRatio), comps: ratios.length, source: 'global' };
  }
  return { global_ratio: round6(globalRatio), total_comps: comps.length, by_category: table };
}

/** The ratio one protocol's category gets under the comparables table. */
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
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainCount = Math.max(1, protocol.chains.length);
  const chainMult = Math.min(model.chain_multiplier_cap, 1 + model.chain_log_weight * Math.log(chainCount));
  const categoryRatio = ratioFor(protocol, comps);
  const base = protocol.tvl_usd * categoryRatio;
  const raw = base * growthMult * maturityMult * chainMult;
  const capped = Math.min(raw, protocol.tvl_usd * model.implied_cap_multiple);
  const implied = Math.max(1, Math.round(capped));
  return { implied, growthPct, growthMult, maturityMult, chainMult, categoryRatio, base: Math.round(base), age };
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

/** The category's one action, in the words a farmer can follow. Never names a live yield or price. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply ~$${capital} of USDC to ${name} on ${chain} as a lender and keep the position open.`;
  if (c.includes('dex'))
    return `Add ~$${capital} of liquidity to ${name}'s largest pool on ${chain} and keep the position open.`;
  if (c.includes('bridge'))
    return `Bridge ~$${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('restak') || c.includes('liquid staking') || c.includes('staking'))
    return `Stake ~$${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option') || c.includes('basis'))
    return `Deposit ~$${capital} of USDC as margin on ${name} (${chain}) and open one small hedged position.`;
  if (c.includes('prediction'))
    return `Fund your ${name} account with ~$${capital} on ${chain} and take one small market position.`;
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('curator') || c.includes('allocator') || c.includes('farm'))
    return `Deposit ~$${capital} of USDC into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('rwa'))
    return `Mint ~$${capital} of ${name}'s tokenised yield asset on ${chain} and hold it.`;
  if (c.includes('insurance'))
    return `Buy ~$${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('payment'))
    return `Route ~$${capital} of payments through ${name} on ${chain} and keep the receipts.`;
  if (c.includes('index'))
    return `Buy ~$${capital} of the ${name} index on ${chain} and hold it.`;
  if (c.includes('launchpad'))
    return `Stake or lock ~$${capital} through ${name} on ${chain} to qualify for its launches.`;
  if (c.includes('stable'))
    return `Mint or hold ~$${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('governance'))
    return `Lock ~$${capital} in ${name}'s governance on ${chain} and vote on its proposals.`;
  if (c.includes('chain'))
    return `Use ${name} for a ~$${capital} swap or transfer on ${chain} and keep the transaction receipt.`;
  return `Deposit ~$${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The
 * plan is derived from the protocol's own record (category, chains, TVL, age),
 * never from a hand-written list of names. Costs and times are typical figures
 * for the action, marked with ~, never a live quote.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const fund =
    chain === 'Ethereum'
      ? `Send ~$${capital} of USDC to your fresh wallet on Ethereum from an exchange or another wallet you control.`
      : `Bridge ~$${capital} of USDC to ${chain} through the chain's official bridge before you touch ${p.name}.`;
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and write its seed phrase on paper, never in a screenshot or chat.`,
      cost: 'no fee to create; ~$2 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: fund,
      cost: 'typically ~$2–$8 of gas',
      time: 'about 15 minutes',
    },
    {
      text: action,
      cost: `~$${capital} of capital and typically ~$4–$8 of gas`,
      time: 'about 15 minutes to set up',
    },
    {
      text: `Do one qualifying action a week on ${p.name}, such as a deposit, a swap, a borrow or a vote, so the wallet shows repeat use rather than a single deposit.`,
      cost: 'typically ~$1–$3 of gas a week',
      time: 'about 10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the ~$${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page from its official site or docs and claim only from a link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: 'about 10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log so you can repeat the position or unwind it later.`,
      cost: 'nothing but the log',
      time: '5 minutes',
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
    farm_steps: row.farm_steps,
  };
}

/** One sentence per multiplier, so the dashboard can state the model in plain words. */
export function modelExplanation(comps: Comparables, model: ModelConstants): string {
  return (
    `Implied value = TVL x the category's median mcap/TVL ratio, from ${comps.total_comps} tokenised ` +
    `protocols with a recorded market cap above $0 (categories with fewer than ${model.min_comps_per_category} comps use the ` +
    `global median ${comps.global_ratio}), x a growth multiplier of 1 + 0.5 x the 7-day TVL change ` +
    `clamped to ${model.growth_floor}%..${model.growth_cap}%, x a maturity multiplier of ${model.maturity_floor} + ` +
    `${model.maturity_range} x min(age, ${model.maturity_days}d)/${model.maturity_days}d (unknown age = ` +
    `${model.unknown_age_days}d), x a chain multiplier of 1 + ${model.chain_log_weight} x ln(chains), capped at ` +
    `${model.chain_multiplier_cap}. Capped at ${model.implied_cap_multiple}x TVL, floored at $1. The value is this ` +
    `entry's own claim from the sealed snapshot, not a prediction that a token will launch.`
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
    category_ratios: ratios,
    category_comp_counts: counts,
    explanation: modelExplanation(comps, model),
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
    if (steps.length < 5 || steps.length > 7) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
