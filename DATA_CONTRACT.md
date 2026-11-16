# Data contract — what `main.ts` writes and what the dashboard may rely on

This file is the contract between `lib/model.ts` (the writer) and
`dashboard/app.js` (the reader). Fields are never renamed or removed; new
fields are added alongside the starter's.

## `board.json`

`{ "rows": BoardRow[200] }`, ranks 1..200, strictly decreasing
`implied_value_usd`. Row shape:

| Field | Type | Notes |
| --- | --- | --- |
| `rank` | number | 1..200 |
| `slug`, `name` | string | from the snapshot |
| `category` | string \| null | from the snapshot |
| `chains` | string[] | from the snapshot |
| `tvl_usd` | number | whole dollars, from the snapshot |
| `change_7d` | number \| null | 7-day TVL change in percent |
| `mcap_usd` | number \| null | always null on the board (pre-token only) |
| `listed_at` | string \| null | `YYYY-MM-DD` or null |
| `gecko_id`, `symbol` | string \| null | always null on the board |
| `token_status` | `'pre-token'` | |
| `age_days` | number \| null | days from `listed_at` to `snapshot.as_of`, null when unknown |
| `implied_value_usd` | integer | strictly decreasing down the board |
| `model` | object | `{ category_ratio, growth_multiplier, maturity_multiplier, chain_multiplier, base, comps, ratio_source }`; `base = tvl_usd x category_ratio` (rounded); `comps` counts the comparables that priced the row; `ratio_source` is `'band'`, `'category'` or `'global'` |
| `farm_steps` | string[8] | each 20–600 chars, action + cost + time; the last two steps are a risk note and what to do after the token launches |

Coverage: all 40 watchlist slugs, plus the 160 pre-token protocols below
the $50M floor with the most TVL. A row is on the board only when
`gecko_id` and `symbol` are both null (and `mcap_usd` null). No row is
ever a protocol that already records a token.

## `data.js`

One statement: `window.RADAR = {...};` — the dashboard's whole dataset, no
fetch, no network. Top-level fields:

| Field | Type | Notes |
| --- | --- | --- |
| `as_of` | string | snapshot date, `YYYY-MM-DD` |
| `source` | string | snapshot source line, verbatim |
| `floor_usd` | number | watchlist floor, $50,000,000 here |
| `model` | object | see below |
| `model_version` | string | `'radar-4'` |
| `watchlist_size` | number | 40 |
| `board_size` | number | 200 |
| `early_size` | number | 160 |
| `live_size` | number | 24 |
| `rows` | RadarRow[200] | board rows, compact form |
| `live` | LiveRow[24] | token-bearing protocols, top 24 by market cap, CEX excluded |
| `watchlist` | string[40] | watchlist slugs, sorted |
| `categories` | string[] | board categories, sorted |
| `chains` | string[] | board chains, sorted |

`model` carries the constants **and** the working, so the judge can verify
the numbers without re-running the program:

| Field | Type | Notes |
| --- | --- | --- |
| `base_multiple` | number | the global median mcap/TVL; the fallback multiple for a category with no comps (kept from the starter's field name) |
| `growth_weight`, `growth_tanh_scale` | number | 0.5, 50 |
| `maturity_floor`, `maturity_range`, `maturity_days`, `unknown_age_days` | number | 0.6, 0.4, 1095, 365 |
| `chain_log_weight`, `chain_multiplier_cap` | number | 0.05, 1.15 |
| `implied_cap_multiple` | number | 50 |
| `shrinkage_k` | number | 3 |
| `tvl_band_factor` | number | 10 |
| `band_min_comps` | number | 2 |
| `winsorize_percentile` | number | 0.95 |
| `winsorize_cap` | number | the 95th percentile of all comp ratios (12.16 here) |
| `global_ratio` | number | global median mcap/TVL over all comps (same value as `base_multiple`) |
| `total_comps` | number | comps used: protocols with a recorded market cap above $0 and positive TVL (128 here) |
| `category_ratios` | Record<string, number> | the median ratio per category (thin categories carry the global ratio) |
| `category_comp_counts` | Record<string, number> | comps per category |
| `calibration` | object | `{ n, spearman_model, spearman_tvl }`: Spearman rank correlation over the tokenised comps between the model's implied values and actual market caps (`spearman_model`), and between TVL and actual market caps (`spearman_tvl`, the baseline); `n` is the comp count (128 here). Computed at build time from the snapshot, never hard-coded; rounded to 6 decimals |
| `explanation` | string | the formula in one plain-English paragraph |

`RadarRow` is the board row in compact form: the starter's fields
(`rank`, `slug`, `name`, `category`, `chains`, `tvl_usd`, `change_7d`,
`mcap_usd`, `listed_at`, `age_days`, `implied_value_usd`,
`growth_multiplier`, `maturity_multiplier`) **plus**
`category_ratio`, `chain_multiplier`, `base`, `comps`, `ratio_source`, and `farm_steps`
(the full 8-step plan, so the page never recomputes it).

`LiveRow`: `{ slug, name, category, chains, tvl_usd, mcap_usd, change_7d }`
— the market's own values, never a model value. The dashboard shows a
`mcap/TVL` column for live rows (`mcap_usd / tvl_usd`), the same ratio the
comparables are built from.

## Farm plans (radar-4)

Eight steps per row, each 20–600 chars, action + cost + time. Gas costs
follow the row's first chain: Ethereum ~$5–$15 a transaction, major L2s
~$0.10–$1, Solana ~$0.01, Tron ~$0.50–$2, other chains ~$0.01–$0.50 —
typical figures marked `~`, never a live quote. Step 7 is a risk note
tailored to the row's category: bridge → bridge/smart-contract risk;
lending/CDP/collateral → oracle + liquidation; perps/derivatives/options/
basis → funding + liquidation; restaking/staking → slashing; dex/liquidity
→ impermanent loss + contract; anything else → contract risk +
may-never-launch. Step 8 covers what to do after the token launches.

## The model, exactly

Comparables: every snapshot protocol with `mcap_usd` non-null and
`mcap_usd > 0` and `tvl_usd > 0` is a comp. 158 protocols record a token
id (`gecko_id`), 144 of them also record a market cap, and 16 of those
record $0 or less (dead or unpriced tokens — Multichain among them — one
even records -1), so 128 are usable comps.

- `ratio(subject)` = the median of `mcap_usd / tvl_usd` over the subject's
  category's comps whose TVL sits within 10x of the subject's TVL, at least
  2 of the category, shrunk toward the same band's global median as
  (n x band_cat + 3 x band_global) / (n + 3). Every comp ratio is winsorized
  at the 95th percentile of all comp ratios (12.16 here) before any median,
  so one near-dead TVL with a live token cannot set a price. When the band
  holds fewer than 2 comps of the category, the category-wide shrinkage
  ratio (n x cat_median + 3 x global) / (n + 3) is used; a category with no
  comps at all takes the global median. Median = the middle value, or the
  mean of the two middle values.
- `growth = 1 + 0.5 x tanh(change_7d / 50)`; `change_7d` null behaves as 0,
  so the multiplier is 1.0.
- `maturity = 0.6 + 0.4 x ln(1 + min(age_days, 1095)) / ln(1 + 1095)`;
  unknown age uses 365 days. `age_days` is whole days from `listed_at` to
  `as_of`.
- `chain = min(1.15, 1 + 0.05 x ln(max(1, chains.length)))`.
- `implied = max(1, min(50 x tvl_usd, round(tvl_usd x ratio x growth x maturity x chain)))`.

Ranking and ties: sort by implied desc, then TVL desc, then slug asc.
Then a deterministic pass lowers any implied value that would tie or pass
the row above it to exactly one dollar below that row's value. The pass
never raises a value and never reorders rows; the adjustment is at most a
few dollars. Multipliers are carried at full precision (the category ratio
at 6 decimals, exactly as the comparables table stores it), so the
dashboard can recompute a row's *pre-tie-break* value exactly from
`tvl_usd`, `category_ratio`, `growth_multiplier`,
`maturity_multiplier`, `chain_multiplier` and the caps above — the
displayed `implied_value_usd` is that value after the tie-break pass.

## The gate (`boardIssue`)

`main.ts` refuses to write a dossier when the board:

- is not exactly `watchlist.length + 160` rows,
- misses any watchlist slug,
- has ranks other than 1..N in order,
- has any row that is not pre-token (token recorded),
- is not strictly decreasing in `implied_value_usd`,
- has all rows sharing one implied value,
- has a row with fewer than 3 or more than 12 farm steps, a step outside
  20–600 characters, or a non-positive implied value.

## Determinism

The same snapshot bytes always produce the same `board.json` and `data.js`
bytes: no clock, no randomness, no network. Ages are measured against
`snapshot.as_of`; ties break on TVL then slug; category tables are built in
sorted category order.
