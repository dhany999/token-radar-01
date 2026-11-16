# Token Radar — a comparables-based token launch radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dhany999/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dhany999/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A make.fun entry for **token-radar-01**: "Build the best token launch radar".
It reads the sealed DefiLlama snapshot (`input/snapshot.json`), ranks the
pre-token protocols by what a token would be worth if the protocol's record
stayed as it is, and gives every ranked protocol a concrete farm plan.

## Run it

Node 22+, standard library only — nothing to install.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit-token-radar-01/token-radar-01-kit/input/snapshot.json
```

In the grader's container the same program runs as `node main.ts` with the
snapshot mounted at `/input/snapshot.json` and writes to `/output`. Flags:

- `--input <snapshot.json|directory>` (default `/input`)
- `--output <dir>` (default `$MAKEFUN_OUTPUT_DIR`, else `/output`)

Outputs: `board.json` (the ranked board), `data.js` (the dashboard's dataset
as `window.RADAR`), `dashboard/` and `screenshots/` copied from this repo,
and `dossier.json` built with the vendored `vendor/makefun-board.ts`.

The program runs twice in grading and both runs must write the same bytes.
The model is fully deterministic: no clock, no randomness, every age is
measured against the snapshot's `as_of` date.

## The model (radar-4)

The house starter valued every protocol at a flat `TVL x 0.25`. This entry
replaces that with **comparables**: the market itself sets the multiple.

1. **Comparables.** Every protocol in the snapshot that already has a token
   *and* a recorded market cap above $0 is a comp — 128 of them on this
   snapshot (158 protocols record a token id, 144 also record a market cap,
   and 16 of those record $0 or less — dead or unpriced tokens such as
   Multichain — so they are not comparables).
   For each protocol the model takes the **median market-cap / TVL ratio**
   of its category's comps whose TVL sits within **10x** of its own TVL (at
   least 2 of them), shrunk toward the same band's global median as
   `(n x cat + 3 x global) / (n + 3)`. Every comp ratio is winsorized at the
   95th percentile (12.160235 here) before any median, so one near-dead TVL
   with a live token cannot set a price. When the band holds fewer than 2
   comps of the category, the category-wide shrinkage ratio is used; a
   category with no comps at all takes the **global median** (0.213803
   here). The table is computed from the snapshot at every run, never
   hard-coded, and `data.js` carries the whole table so the judge can see
   the working.
2. **Implied value.**
   `implied = TVL x band_ratio x growth x maturity x chain`,
   capped at 50x TVL and floored at $1:
   - `growth = 1 + 0.5 x tanh(change_7d / 50)` (missing 7-day change → 1.0;
     saturating, so one wild week cannot dominate)
   - `maturity = 0.6 + 0.4 x ln(1 + min(age_days, 1095)) / ln(1 + 1095)`
     (unknown `listed_at` → 365 days; a log curve, so the early years
     matter most)
   - `chain = min(1.15, 1 + 0.05 x ln(number of chains))`
3. **Strict ranking.** Rows sort by implied value desc, then TVL desc, then
   slug asc. A deterministic pass then lowers any implied value that would
   tie the row above it to one dollar below it, so the board is strictly
   decreasing and the rank order is unambiguous.

The board is the whole 40-protocol watchlist plus the 160 pre-token
protocols below the $50M floor with the most TVL: **200 rows**. Protocols
that already have a token are kept apart as a live set (top 24 by market
cap), shown at the market's own values, never mixed into the ranking.

## Checked against the market

The model is validated on the 128 tokenised comps, at build time, from the
snapshot itself — never hard-coded. Spearman rank correlation between the
model's implied values and the comps' actual market caps is **0.58**, vs
**0.44** for TVL alone, so the ranking tracks real market caps better than
size alone. A leave-one-out sweep of 15 band x shrinkage settings found no
setting that beats the chosen 10x / k=3 clearly (best 1.48 vs 1.61 median
abs log error, within noise), so the width is the principled middle, not a
tuned peak. The level error is deliberately not reported: individual
mcap/TVL ratios are extremely dispersed, so a median-based model can rank
well while any single level is off by several times. Both correlations and
n are stored in `data.js` under `model.calibration` and shown in the
dashboard's model explainer.

## Farm plans

Every row carries 8 steps, each with a cost and a time, derived from the
protocol's own category, chains, TVL tier and age — never from a list of
names. Capital is ~$250 / $150 / $100 / $50 by TVL tier; the hold is 60 /
45 / 30 days by age. Gas costs follow the protocol's first chain
(Ethereum ~$5–$15 a transaction, major L2s ~$0.10–$1, Solana ~$0.01,
other chains by tier), and the risk note (step 7) names the risk the
protocol's own category actually carries — bridge / smart-contract risk
for bridges, oracle + liquidation for lending, funding + liquidation for
perps and derivatives, slashing for restaking and staking, impermanent
loss + contract risk for dexes and liquidity, contract risk + may-never-
launch for everything else. The last step covers what to do after the
token launches. Costs and times are typical figures (marked `~`), never a
live quote, and no step claims a live yield or price.

## Data contract

See [DATA_CONTRACT.md](DATA_CONTRACT.md) for the exact `window.RADAR`
shape, the board.json row shape, and what the dashboard may rely on.

## Layout

- `main.ts` — entrypoint: read snapshot, build board, write outputs, build dossier
- `lib/model.ts` — the model, the board builder, the farm plans, the gate
- `vendor/makefun-board.ts` — make.fun's dossier library, copied byte-for-byte from the kit
- `dashboard/` — the static page (index.html, app.css, app.js)
- `screenshots/` — 1-board, 2-detail, 3-filtered

## Caveat

An implied value is this entry's own claim from the sealed snapshot. It is
not a prediction that a token will launch, when it will, or what it will
trade at — the snapshot carries no such signal, and neither does this model.
