# Protocol coverage

The bot consumes exactly what a Showdown *player* receives: the public
`update` channel plus its own `sideupdate`. Below is every message type
handled by `BattleTracker.seeLine()` and why it matters.

## Own team (exact, from `\|request\|`)

`seeRequest()` ingests `request.side.pokemon[]`:

| Field | Use |
|---|---|
| `ident/details/condition` | species, level, exact HP, status |
| `stats` | real atk/def/spa/spd/spe for damage math |
| `moves` | legal move ids (joined with `active[].moves` availability) |
| `item`, `baseAbility`, `ability` | own loadout |
| `active`, `reviving`, `commanding` | choice legality |

Plus per-active-mon flags from `request.active[]`: `trapped`,
`maybeTrapped`, `canMegaEvo`, `canDynamax`, `canTerastallize`.

## Foe team (public knowledge only)

| Message | Tracked as |
|---|---|
| `\|switch\|` / `\|drag\|` | new/returning `TrackedPokemon`; active slot swap |
| `\|replace\|` | Illusion break — corrects species mid-battle |
| `\|-damage\|` / `\|-heal\|` | HP ratio updates |
| `\|-status\|` / `\|-curestatus\|` | status set/clear |
| `\|move\|` | revealed move list (id-normalized) |
| `\|-ability\|` / `\|-item\|` / `\|-enditem\|` | revealed traits |
| `\|-mega\|`, `\|-burst\|`, `\|-primal\`, `\|-formechange\|` | species/type refresh via dex lookup |
| `\|-terastallize\|` | Tera type; defending types replaced by Tera type |
| `\|-weather\|` | active weather |
| `\|-fieldstart\|` / `\|-fieldend\|` | active terrain |
| `\|turn\|` | turn counter |

## Battle end (omniscient stream)

`battle-runner.js` scans for `\|win\|name`, `\|tie\|`, `\|turn\|N` and the
final `end {json}` message to build `{winner, winnerSide, turns}`.

## Deliberately ignored (for now)

- Side hazards (`|-sidestart|`) and side conditions — no hazard-avoidance
  scoring yet ([roadmap](roadmap.md)).
- `\|-boost\|/\|-unboost\|` stat stages — damage model is stage-naive.
- `\|-singleturn\|` etc. (Protect counters) — Protect is scored statically.

These gaps are safe: ignoring information only makes the bot weaker, never
illegal.
