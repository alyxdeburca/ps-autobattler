# PS Auto-Battler

A heuristic auto-battler for [Pokémon Showdown](https://github.com/smogon/pokemon-showdown)'s
headless battle engine. Two AIs (or AI vs. the bundled `RandomPlayerAI`) play
complete battles through the simulator's stream protocol — no server, no browser.

## Architecture

```
pokemon-showdown/            upstream clone (built to dist/)
autobattler/
  src/
    dex-shim.js              loads game data from the compiled Dex
    battle-state.js          tracks public battle state from protocol lines
    estimator.js             damage / matchup math (Gen 5+ formula, estimated foe stats)
    heuristic-ai.js          BattlePlayer subclass: scores every legal choice, picks the best
    battle-runner.js         runs battles, tallies results, CLI entry point
  test/
    run-tests.js             smoke tests: tracker parsing + full battles
```

### How a decision is made

1. The engine sends a `|request|` (JSON) on the player's stream each turn.
2. `BattleTracker` merges it into known state (own team = exact; foe = public info only).
3. Every legal move is scored with an expected-damage model:
   Gen 5+ damage formula, STAB, type chart (Tera-aware), burn, accuracy,
   multi-hit averaging, plus bonuses for OHKOs, setup, healing, status, hazards.
4. Switching is scored as "how well does the incoming mon match up vs. the foe".
5. Highest score wins; any internal error falls back to `default` so a bug can
   never hang a battle.

## Usage

```bash
# from autobattler/
node src/battle-runner.js --games 20 --format gen9randombattle --p2 random
node src/battle-runner.js --games 5 --p2 heuristic   # mirror match
node src/battle-runner.js --games 1 --verbose        # watch the protocol live
```

API:

```js
const { runBattle } = require('./src/battle-runner');
const result = await runBattle({ formatid: 'gen9randombattle', p2: 'random' });
// { winner, winnerSide, turns, log, durationMs }
```

## Status

- [x] Protocol tracking (switches, HP/status changes, moves, items, abilities,
      Tera, weather/terrain)
- [x] Damage estimation & legal-choice enumeration (type chart immunities,
      STAB, burn, accuracy, multi-hit averaging)
- [x] Heuristic decision loop with switch scoring and safe fallbacks
- [ ] Deeper play: hazard tracking, prediction, pivot logic
- [ ] Chrome extension packaging (deliberately deferred until requested)

### Measured results (gen9randombattle)

| matchup                        | result        |
|--------------------------------|---------------|
| heuristic vs. RandomPlayerAI   | **69–31** (100 games), ~240ms/battle |
| heuristic vs. RandomPlayerAI   | 15–5 (gen8randombattle, 20 games) |
| heuristic vs. heuristic        | 6–4 (mirror sanity check) |

