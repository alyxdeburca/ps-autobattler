# Roadmap

Ordered by expected impact. Nothing here is started until requested — in
particular, **Chrome extension packaging is intentionally deferred** per
project direction.

## Smarter play (engine-side)

1. **Stat-stage tracking** — parse `|-boost|/|-unboost|`, apply stages to the
   damage model (`(2+s)/2` multiplier) and to switch decisions.
2. **Hazard awareness** — track `|-sidestart|`; add hazard-tolerance to
   `matchupScore` (Boots detection, Ghost immunities to Spinblock etc.) and a
   "don't re-switch into rocks" penalty.
3. **Item/ability inference** — probability-weight common random-battle items
   (Choice lock from repeated same-move, Boots when hazards don't chip…).
4. **Screens & weather multipliers** — consume already-tracked field state in
   the damage formula.
5. **Prediction light** — if foe's best move KOs us but our switch-in resists
   it, weight the pivot higher (a 1-ply opponent model).

## Search & learning

6. **1-ply expectiminimax** — enumerate (our choice × foe's plausible moves)
   using damage distributions; pick max-min. The tracker already holds all
   inputs needed.
7. **Weights as config** — externalize `SCORES` to JSON; auto-tune against
   the random baseline via CMA-ES-style hill climbing on win rate.

## Platform

8. **Chrome extension** — bundle this package + compiled sim with esbuild,
   drive battles inside a Showdown tab; UI overlay showing bot's scored
   options live. *Deferred until explicitly requested.*
9. **Format coverage** — verify doubles choices (`active[]` >1, target
   suffixes) beyond singles; add gen3–7 smoke benchmarks.

## Ops

10. **CI** — GitHub Actions: `npm test` + 20-game benchmark on every push;
    comment win rate on PRs.
