# PS Auto-Battler

A heuristic auto-battler for [Pokémon Showdown](https://github.com/smogon/pokemon-showdown)'s
headless battle engine. Two AIs play complete Pokémon battles through the
simulator's stream protocol — no server, no browser, no human input.

**Headline result:** wins **69%** of games against Showdown's bundled
`RandomPlayerAI` on `[Gen 9] Random Battle` (69–31 across 100 simulated games),
at roughly **4 battles per second**.

```bash
git clone https://github.com/alyxdeburca/ps-autobattler
cd ps-autobattler
# one-time: build the sibling simulator dependency (see Setup below)
node src/battle-runner.js --games 100 --p2 random
```

## Features

- **Full-battle automation** — drives the official Showdown simulator end to
  end: team preview, moves, switches, forced switches, faint replacement.
- **Fair-play information model** — the bot reads *only its own side stream*:
  exact data for its own team, public-only data for the opponent (species,
  types, %HP, revealed moves/items/abilities). Nothing is peeked from the
  engine internals.
- **Live battle-state tracking** — maintains a continuously-updated model of
  both sides from ~20 protocol message types (switches, damage, statuses,
  items, abilities, Tera, weather, terrain…).
- **Damage-based decision making** — scores every legal choice each turn with
  a Gen 5+ damage model (type chart incl. immunities, STAB, burn, accuracy,
  multi-hit averaging) plus positional bonuses (OHKOs, likely KOs, setup,
  healing, status spread, hazards) and switch-matchup analysis.
- **Never hangs, never crashes** — any internal error falls back to the
  engine's safe `default` choice; unavailable choices are retried.
- **Deterministic, scriptable runner** — CLI and API access, optional PRNG
  seeds, live protocol echo, win/loss tallying.

## Repository layout

```
autobattler/
├── src/
│   ├── dex-shim.js        game-data bridge to the compiled Showdown Dex
│   ├── battle-state.js    BattleTracker: public-information state machine
│   ├── estimator.js       damage / matchup math
│   ├── heuristic-ai.js    HeuristicPlayerAI (BattlePlayer subclass)
│   └── battle-runner.js   orchestration, result tallying, CLI
├── test/run-tests.js      unit + integration smoke tests
└── docs/                  deep-dive documentation (start with architecture.md)
```

## Setup

The bot runs against the **compiled** Showdown simulator, kept as a sibling
directory:

```bash
# 1. Clone and build the simulator (outside this repo)
git clone --depth 1 https://github.com/smogon/pokemon-showdown
cd pokemon-showdown && npm install --no-optional && ./build && cd ..

# 2. Run the bot (no npm install needed — zero runtime deps of its own)
cd autobattler
node src/battle-runner.js --games 1 --verbose
```

> The relative path `../pokemon-showdown/dist` is resolved from this repo's
> location; keep the two directories side by side as cloned above.

## Usage

### CLI

```bash
node src/battle-runner.js [options]

--games N        number of battles to simulate       (default 1)
--format ID      Showdown format id                 (default gen9randombattle)
--p2 TYPE        opponent AI: random | heuristic    (default random)
--verbose        echo live protocol lines to stdout
--quiet          suppress per-game result lines
```

Examples:

```bash
node src/battle-runner.js --games 20                          # quick series
node src/battle-runner.js --games 100 --quiet                 # benchmark
node src/battle-runner.js --games 5 --p2 heuristic            # mirror match
node src/battle-runner.js --games 1 --format gen8randombattle # cross-gen check
node src/battle-runner.js --games 1 --verbose                 # watch it think
```

### API

```js
const { runBattle } = require('./src/battle-runner');

const result = await runBattle({
  formatid: 'gen9randombattle',
  p2: 'random',          // 'random' | 'heuristic'
  // seed: [a, b, c, d], // reproducible PRNG seed
  // debug: true,        // echo engine protocol to stderr
  // onLog: line => ...  // live protocol callback
});
// result => { winner, winnerSide, turns, log, durationMs }
```

### Tests

```bash
npm test          # 7 checks: parsing, tracking, estimator sanity, live battle
```

## Results

Measured with `node src/battle-runner.js`, committed verbatim:

| matchup | format | result | avg time |
|---|---|---|---|
| heuristic vs. `RandomPlayerAI` | gen9randombattle | **69–31** (100 games) | ~240 ms/game |
| heuristic vs. `RandomPlayerAI` | gen8randombattle | 15–5 (20 games) | ~355 ms/game |
| heuristic vs. heuristic | gen9randombattle | 6–4 (mirror sanity check) | ~330 ms/game |

## Documentation

Deep dives live in [`docs/`](docs/):

1. [`docs/architecture.md`](docs/architecture.md) — components, data flow, life of a turn
2. [`docs/ai.md`](docs/ai.md) — the decision pipeline and every scoring rule
3. [`docs/protocol.md`](docs/protocol.md) — exactly which protocol messages are consumed and why
4. [`docs/estimator.md`](docs/estimator.md) — the damage model, worked examples, accuracy limits
5. [`docs/testing.md`](docs/testing.md) — test suite, benchmarks, reproduction steps
6. [`docs/roadmap.md`](docs/roadmap.md) — planned improvements (extension packaging intentionally deferred)

## Credits

- **Auto-battler design & implementation:** [ox-alpha](https://github.com/alyxdeburca/ps-autobattler) — AI model by an undisclosed organization.
- **Battle engine, game data, protocol & `RandomPlayerAI`:**
  [Pokémon Showdown](https://github.com/smogon/pokemon-showdown) by Guangcong Luo ([Zarel](https://github.com/Zarel)) and the Smogon community — MIT licensed.
- **Type chart, stats & damage formula:** Nintendo, Game Freak, Creatures Inc. / The Pokémon Company.
  This is an unofficial fan tool; it is not affiliated with or endorsed by them.

## License

[MIT](LICENSE) — like the simulator it drives.

