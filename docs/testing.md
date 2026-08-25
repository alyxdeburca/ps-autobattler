# Testing & benchmarks

## Test suite

`test/run-tests.js` — plain Node asserts, no framework:

| Check | Verifies |
|---|---|
| `parseDetails` | species/level/gender extraction from details strings |
| `parseCondition` | HP fractions, percent views, status, faint handling |
| tracker request merge | own-team exact state (`stats`, moves, active flags) |
| tracker public lines | foe switch/damage/status tracking, multi-mon bookkeeping |
| estimator immunity | Normal move vs. Gengar (Ghost) ⇒ **0%** |
| estimator ranges | neutral Earthquake vs. same-species in sane bounds; SE ≫ resisted |
| integration battle | full live battle completes with a decided winner |

Run:

```bash
npm test        # or: node test/run-tests.js
```

All 7 checks pass on the committed code.

## Reproducing the benchmark numbers

```bash
# 100 games vs. random AI (gen9randombattle)
node src/battle-runner.js --games 100 --quiet

# cross-generation sanity
node src/battle-runner.js --games 20 --format gen8randombattle --quiet

# mirror match (determinism/crash check)
node src/battle-runner.js --games 10 --p2 heuristic --quiet
```

Reference outputs (committed in README):

```
bot wins: 69 | opponent wins: 31 | ties: 0     # gen9, 100 games
bot wins: 15 | opponent wins: 5                # gen8, 20 games
bot wins: 6  | opponent wins: 4                # mirror, 10 games
```

Variance note: single-run results swing ±10% across sessions because teams
are re-randomized per battle. Use `--games 100` for stable numbers.

## Regression watch-list

When touching scoring code, re-run all three commands above and compare
against reference outputs. A drop of >10 percentage points at n=100 is a
real regression, not noise.
