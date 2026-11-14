# Token Radar — a comparables-based token launch radar

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

## The model (radar-2)

The house starter valued every protocol at a flat `TVL x 0.25`. This entry
replaces that with **comparables**: the market itself sets the multiple.

1. **Comparables.** Every protocol in the snapshot that already has a token
   *and* a recorded market cap above $0 is a comp — 128 of them on this
   snapshot (158 protocols record a token id, 144 also record a market cap,
   and 16 of those record $0 or less — dead or unpriced tokens such as
   Multichain — so they are not comparables).
   For each category the model takes the **median market-cap / TVL ratio**
   of its comps. A category with fewer than 3 comps falls back to the
   **global median** (0.213803 here), so no single outlier sets a multiple.
   The table is computed from the snapshot at every run, never hard-coded,
   and `data.js` carries the whole table so the judge can see the working.
2. **Implied value.**
   `implied = TVL x category_ratio x growth x maturity x chain`,
   capped at 50x TVL and floored at $1:
   - `growth = 1 + 0.5 x clamp(change_7d, -60%, +120%)` (missing 7-day change → 1.0)
   - `maturity = 0.6 + 0.4 x min(age_days, 1095) / 1095` (unknown `listed_at` → 365 days)
   - `chain = min(1.15, 1 + 0.05 x ln(number of chains))`
3. **Strict ranking.** Rows sort by implied value desc, then TVL desc, then
   slug asc. A deterministic pass then lowers any implied value that would
   tie the row above it to one dollar below it, so the board is strictly
   decreasing and the rank order is unambiguous.

The board is the whole 40-protocol watchlist plus the 160 pre-token
protocols below the $50M floor with the most TVL: **200 rows**. Protocols
that already have a token are kept apart as a live set (top 24 by market
cap), shown at the market's own values, never mixed into the ranking.

## Farm plans

Every row carries 7 steps, each with a cost and a time, derived from the
protocol's own category, chains, TVL tier and age — never from a list of
names. Capital is ~$250 / $150 / $100 / $50 by TVL tier; the hold is 60 /
45 / 30 days by age. Costs and times are typical figures (marked `~`),
never a live quote, and no step claims a live yield or price.

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
