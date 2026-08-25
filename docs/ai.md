# The AI: decision pipeline

Every time the engine sends a `\|request\|`, `HeuristicPlayerAI` runs this
pipeline:

```
receiveRequest(request)
   │
   ├─ tracker.seeRequest()        merge exact own-team data
   │
   ├─ request.teamPreview?  →  "default" ordering (v1)
   ├─ request.forceSwitch?  →  decideForceSwitch()
   └─ request.active?       →  decideMove()
                                  │
              ┌───────────────────┴────────────────────┐
              ▼                                        ▼
      score every usable move                  score best bench switch
      (expected damage + bonuses)              (matchupScore − switch tax)
              └───────────────┬────────────────────────┘
                              ▼
                   pick highest total, send choice
```

## Scoring a move

For each non-disabled move slot:

1. **Expected damage %** — `estimator.expectedDamagePct()` (see
   [estimator.md](estimator.md)): Gen 5+ formula × STAB × type multiplier ×
   burn, divided by estimated foe max HP, multiplied by accuracy.
2. **Bonus:** +1000 if ≥100% (guaranteed OHKO), else **+30** if damage ≥
   foe's current HP fraction (likely KO).
3. **Status moves replace their (zero) damage score** with a category value
   from `scoreStatusMove()`:

| Category | Score |
|---|---|
| Setup (`raise atk/spa/spe/def…`) | +14 |
| Healing | +20 |
| Status infliction vs. unstatused foe | +18 |
| Hazards (Stealth Rock / Spikes…) | +12 |
| Protection | +6 |
| Phazing | +3 |
| Generic utility | +1 |

4. **Secondary effects:** damaging moves with a status secondary get
   `18 × chance/200` extra.
5. **Low-PP nudge:** −3 when a move is down to its last PP.

## Scoring a switch

`matchupScore(mon, foe)` = defensive term − offensive term:

- **Defensive:** for each foe type `t`, subtract
  `8 × typeMultiplier(t, myTypes)`.
- **Offensive:** half of the best expected-damage % across the incoming
  mon's known moves.

Then: `switch score = matchupScore + 10×hpRatio − 6` (the −6 discourages
pivot spam). Switching competes with moves on the same scale, so a switch
only wins when it clearly improves positioning.

## Forced switches & team preview

- `decideForceSwitch()` mirrors the engine's legality rules exactly:
  replacement slots only, no duplicates, fainted-only candidates during
  Revival Blessing; falls through to `pass` when nothing legal remains.
- Team preview currently sends `default` (engine's standard ordering);
  smarter lead selection is on the [roadmap](roadmap.md).

## Robustness

- Any thrown error inside decision code logs and sends `default`.
- `[Unavailable choice]` errors are swallowed (the engine re-prompts).
- Every protocol line parse failure is recorded in `stats.errors` without
  interrupting play.
