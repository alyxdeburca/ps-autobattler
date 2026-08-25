# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-08-25

### Added
- Heuristic auto-battler for Pokémon Showdown's headless engine:
  `BattleTracker` public-information world model, damage estimator with type
  chart/immunities/STAB/burn/accuracy, `HeuristicPlayerAI` decision loop with
  switch scoring, fail-safe fallbacks, and a deterministic battle runner CLI/API.
- Test suite (7 checks incl. full live battles).
- Documentation set: architecture, AI pipeline, protocol coverage, estimator
  math, testing guide, roadmap.

### Performance
- **69–31** vs. `RandomPlayerAI` over 100 gen9randombattle games (~240 ms/game);
  **15–5** on gen8randombattle; mirror match stable.

### Fixed
- Bot now consumes public protocol lines from its own stream — previously it
  played with zero knowledge of the opposing team (~10% → 60% win rate).
- Immunities no longer neutralized by a `(x || 1)` fallback in the damage
  formula that resurrected zero multipliers.

### Security / Fair play
- The AI reads only player-visible protocol data; no access to hidden engine
  state by construction.
