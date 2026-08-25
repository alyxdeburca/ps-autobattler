# Architecture

How the auto-battler is put together, how data flows through it, and what
happens during one turn of battle.

## Big picture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Pokémon Showdown (sibling repo)                 │
│                                                                     │
│   BattleStream  ──►  Battle (engine: sim/battle.ts)                 │
│      │               • applies choices, rolls RNG, emits protocol   │
│      │ getPlayerStreams()                                           │
│      ├── omniscient : full public log        ──► battle-runner.js   │
│      ├── p1         : our sideupdate+updates ──► HeuristicPlayerAI  │
│      └── p2         : foe sideupdate+updates ──► RandomPlayerAI     │
└─────────────────────────────────────────────────────────────────────┘
         ▲ choices ("move 2", "switch 3")          │ protocol text
┌────────┴──────────────────────────────────────────▼──────────────────┐
│                        autobattler (this repo)                       │
│                                                                      │
│  HeuristicPlayerAI                                                   │
│    ├── receiveLine()   → BattleTracker.seeLine()   (world model)     │
│    ├── receiveRequest() → decideMove()/decideForceSwitch()           │
│    │       └── estimator.js  +  dex-shim.js  (scoring math)          │
│    └── choose(best)    → stream.write(choice)                        │
└──────────────────────────────────────────────────────────────────────┘
```

## Components

| File | Responsibility |
|---|---|
| `src/battle-runner.js` | Owns the `BattleStream`, splits per-player streams, starts both AIs, parses the omniscient log for winner/turn count, exposes `runBattle()` and the CLI. |
| `src/heuristic-ai.js` | A `BattlePlayer` subclass. Converts each `\|request\|` into legal choices, scores them via the estimator + tracker, sends the best. Also feeds every non-request line to the tracker. |
| `src/battle-state.js` | `BattleTracker`: merges requests (own team, exact) and public lines (foe, partial) into `TrackedPokemon` records; answers "who's active, what's revealed, how hurt" queries. |
| `src/estimator.js` | Pure math: stat estimation, STAB/type multipliers, Gen 5+ damage formula, expected damage after accuracy. No I/O, no state. |
| `src/dex-shim.js` | Lazily initializes a format-aware `Dex` from `../pokemon-showdown/dist/sim/index.js`; exposes species/move/item/ability lookups and type-chart helpers. |

## Design constraints

1. **Fair play.** The AI subscribes to exactly what a Showdown client would
   receive on its own player stream. Hidden information (foe HP totals,
   unrevealed moves/items/abilities, EVs/nature) is never read from engine
   internals — only estimated.
2. **No TypeScript toolchain.** The bot requires CommonJS against the
   *compiled* simulator (`dist/`). This keeps the runtime footprint tiny and
   makes future browser bundling straightforward.
3. **Fail-safe decisions.** `receiveRequest()` wraps everything in try/catch;
   any scoring bug degrades to the engine's `default` choice instead of
   hanging the battle. `[Unavailable choice]` errors are swallowed and
   retried when the engine re-requests.
