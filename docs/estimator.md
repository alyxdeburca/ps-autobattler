# The estimator: damage math and its limits

`src/estimator.js` converts (attacker, defender, move) into an expected
damage percentage. It is intentionally a *fair* model — foe stats are
estimated from public data, never read from the engine.

## Inputs

| Input | Source | Fidelity |
|---|---|---|
| attacker level/types/status | own team request | exact |
| attacker stats | own team request (`stats`) | exact |
| move object | Dex lookup by id | exact (BP, type, category, accuracy…) |
| defender types | tracker (species or revealed Tera) | exact once seen |
| defender level/details | tracker | exact |
| defender stats | **estimated** from base stats | approximation |

## Stat estimation

For foes we assume level = their shown level, 31 IVs, neutral nature,
~85 EVs everywhere:

```
hp = floor((2·base + 31 + 21) · L / 100) + L + 10
stat = floor((2·base + 31 + 85) · L / 100) + 5
```

Random-battle foes are generated with standard spreads close to this, so
estimates are typically within ±10%.

## Formula

Gen 5+ core:

```
base = floor(floor((2L/5 + 2) · Power · A/D) / 50) + 2
dmg  = base · STAB · TypeEff · Burn · Screens
```

then:

- STAB = 1.5 when the move type is one of the attacker's types.
- `TypeEff` multiplies 2/0.5 per defending type; **0 if immune**
  (`Dex.getImmunity`). Note the implementation must multiply directly — a
  `x \|\| 1` fallback silently resurrects immunities (this was a real bug).
- Burn halves physical damage.
- Multi-hit moves ×3 (average of the 2–5 roll).
- Fixed-damage moves (Seismic Toss etc.) use their flat number.
- OHKO moves return 100%.
- Expected value multiplies by accuracy.

## Worked example

Garchomp L81 (atk 182) Earthquake vs. Gengar L78:

- Ground vs Ghost/Poison = 1× ×1× → neutral; no STAB for Garchomp? Ground
  **is** Garchomp's type → 1.5×.
- Estimated Gengar HP at L78 ≈ `(2·60+31+21)·0.78 + 88 ≈ 250`.
- Base ≈ `floor((34·100·182/150)/50)+2 ≈ 82`; final ≈ 82·1.5 ≈ 123 →
  ~49% of 250 HP. Matches in-battle observation (~45–55%).

## Known limits

- Ignores stat stages, screens (field flag not yet tracked), items
  (Choice band/specs, Life Orb), abilities that alter damage (Levitate as
  immunity, Multiscale, Flash Fire…), weather boosts, crits, and spread
  modifiers.
- Status-move scoring is static categories, not state-aware probabilities.

Consequence: the bot's *ordering* of options is usually right, individual
percentages are rough. Empirically this is enough for a strong-vs-random
baseline ([results](../README.md#results)); closing these gaps is the main
[roadmap](roadmap.md) theme.
