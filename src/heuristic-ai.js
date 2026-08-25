/**
 * heuristic-ai.js
 *
 * A BattlePlayer subclass implementing a damage-based heuristic AI:
 *
 *   1. Parse the `|request|` to enumerate legal choices (moves / switches).
 *   2. Score each choice:
 *        move    = expected damage % + effect bonuses - risk penalties
 *        switch  = how well the incoming mon matches up vs. the foe
 *   3. Pick the best-scoring choice and send it.
 *
 * It plays only from information visible on its own side stream -- no peeking
 * at hidden foe state.
 */
'use strict';

const { BattlePlayer } = require('../../pokemon-showdown/dist/sim/battle-stream');
const trackerMod = require('./battle-state');
const dex = require('./dex-shim');
const est = require('./estimator');

const { BattleTracker } = trackerMod;

// ---------------------------------------------------------------------------
// Scoring knobs
// ---------------------------------------------------------------------------
const SCORES = {
	OHKO: 1000,
	KILL_CONF: 0.9,
	TYPE_BONUS: 8,
	STATUP_SELF: 14,
	HEAL_SELF: 20,
	STATUS_FOE: 18,
	HAZARD: 12,
	PIVOT_BONUS: 4,
	SWITCH_IN_PENALTY: 6, // cost of giving up a turn
	LOW_PP: -3,
};

/** Value of bringing `mon` in against the current active foe (higher=better). */
function matchupScore(monView, foeView) {
	if (!monView || !foeView) return 0;
	const monSp = dex.speciesFromId(monView.species);
	if (!monSp) return 0;

	let score = 0;
	const myTypes = monView.types || monSp.types;
	const foeTypes = foeView.types || [];

	// Defensive: how hard is the foe hitting us?
	for (const ft of foeTypes) {
		score -= est.typeMultiplier(ft, myTypes) * SCORES.TYPE_BONUS;
	}
	// Offensive: how hard can we hit back (best move)?
	let best = 0;
	for (const mvId of monView.moves || []) {
		const mv = dex.moveFromId(mvId);
		if (!mv || mv.category === 'Status') continue;
		best = Math.max(best, est.expectedDamagePct({
			attacker: { species: monView.species, level: monView.level, types: myTypes },
			defender: { types: foeTypes },
			move: mv,
			attackerStats: monView.stats || est.estimateStats(monSp, monView.level),
			defenderSpecies: dex.speciesFromId(foeView.species),
		}));
	}
	score += Math.min(best, 100) * 0.5;
	return score;
}

class HeuristicPlayerAI extends BattlePlayer {
	constructor(playerStream, options = {}) {
		super(playerStream, options.debug);
		this.name = options.name || 'HeuristicBot';
		this.seed = options.seed !== undefined ? options.seed : null;
		this.mySideId = options.mySideId || null; // set when we see our own side data
		this.tracker = new BattleTracker(options.side || 'p1');

		this.stats = {
			requests: 0,
			movesChosen: 0,
			switchesChosen: 0,
			errors: [],
		};
	}

	receiveError(error) {
		// Unavailable choices get retried with fresh state; anything else bubbles.
		if (error.message.startsWith('[Unavailable choice]')) return;
		this.stats.errors.push(error.message);
		throw error;
	}

	receiveRequest(request) {
		try {
			this.tracker.seeRequest(request);

			if (request.wait) return; // nothing to decide

			if (request.teamPreview) {
				this.choose(this.chooseTeamPreview(request));
				return;
			}

			if (request.forceSwitch) {
				this.choose(this.decideForceSwitch(request));
				return;
			}

			if (request.active) {
				this.choose(this.decideMove(request));
				return;
			}
		} catch (err) {
			// Never let an AI bug hang the battle: fall back to a safe default.
			this.stats.errors.push(`fallback: ${err && err.message}`);
			try {
				this.choose('default');
			} catch (e) { /* stream already closed */ }
		}
	}

	// -------------------------------------------------------------------------
	// Decision helpers
	// -------------------------------------------------------------------------

	chooseTeamPreview(request) {
		return 'default';
	}

	decideForceSwitch(request) {
		const musts = request.forceSwitch;
		const side = request.side;
		const chosen = [];
		const choices = [];
		for (let i = 0; i < musts.length; i++) {
			if (!musts[i]) { choices.push('pass'); continue; }
			const reviving = !!(side.pokemon[i] && side.pokemon[i].reviving);
			const options = [];
			for (let j = 1; j <= side.pokemon.length; j++) {
				const pd = side.pokemon[j - 1];
				if (!pd) continue;
				// Active replacement slots are only legal when reviving.
				if (!(j > musts.length || reviving)) continue;
				if (chosen.includes(j)) continue;
				const fainted = pd.condition.endsWith(' fnt');
				// Normal: need a healthy mon. Revival Blessing: need a fainted one.
				if (!fainted !== !reviving) continue;
				options.push(j);
			}
			if (!options.length) { choices.push('pass'); continue; }
			const best = this.bestSwitchSlot(request, options);
			chosen.push(best);
			choices.push(`switch ${best}`);
		}
		return choices.join(', ');
	}

	bestSwitchSlot(request, candidateSlots) {
		const foeView = this.tracker.foeView();
		let best = candidateSlots[0];
		let bestScore = -Infinity;
		for (const slot of candidateSlots) {
			const pd = request.side.pokemon[slot - 1];
			const d = trackerMod.parseDetails(`${pd.details}`);
			const sp = dex.speciesFromId(d.species);
			if (!sp) continue;
			const view = {
				species: d.species,
				level: d.level,
				types: sp.types.slice(),
				moves: (pd.moves || []).slice(),
				stats: { ...pd.stats },
				hpRatio: (() => {
					const c = trackerMod.parseCondition(pd.condition);
					return c.maxHP ? c.curHP / c.maxHP : 0;
				})(),
			};
			const score = matchupScore(view, foeView) +
				view.hpRatio * 10; // prefer healthy mons
			if (score > bestScore) { bestScore = score; best = slot; }
		}
		return best;
	}

	decideMove(request) {
		const meActive = request.active[0];
		const side = request.side;
		const activePd = side.pokemon.find(p => p.active) || side.pokemon[0];

		const foeView = this.tracker.foeView();
		const myTypes = (() => {
			const sp = dex.speciesFromId(activePd.details.split(', ')[0]);
			return sp ? sp.types : [];
		})();
		const attacker = {
			species: activePd.details.split(', ')[0],
			level: (trackerMod.parseDetails(`${activePd.details}`)).level,
			types: myTypes,
			status: trackerMod.parseCondition(activePd.condition).status,
		};
		const defenderSpecies = foeView ? dex.speciesFromId(foeView.species) : null;

		const candidates = [];
		const pushMove = (slot, mvName, extraScore, tags) => {
			candidates.push({ slot, mvName, extraScore, tags });
		};

		// --- damaging/status moves --------------------------------------
		meActive.moves.forEach((md, idx) => {
			if (md.disabled) return;
			const mv = dex.moveFromId(md.id);
			if (!mv) return;
			const dmg = est.expectedDamagePct({
				attacker, defender: foeView || {}, move: mv,
				attackerStats: activePd.stats,
				defenderSpecies,
			});
			let score = dmg;
			if (dmg >= 100) score += SCORES.OHKO;
			else if (foeView && dmg >= foeView.hpRatio * 100) score += 30; // likely KO
			else if (dmg < 15 && mv.category === 'Status') score -= 5;

			// Status / utility moves.
			if (mv.category === 'Status') {
				score = this.scoreStatusMove(mv, request, foeView);
			}

			// Secondary effects: rough bonus for status-inflicting secondaries.
			if (mv.secondary && mv.secondary.status && foeView &&
				!foeView.status && dmg > 0) {
				score += SCORES.STATUS_FOE * (mv.secondary.chance || 100) / 200;
			}
			if ((md.pp | 0) === 1) score += SCORES.LOW_PP;

			pushMove(idx + 1, md.id, score, { dmg });
		});

		// --- switch option ------------------------------------------------
		const trapped = meActive.trapped || meActive.maybeTrapped;
		let switchChoice = null;
		if (!trapped) {
			const benchSlots = [];
			for (let j = 1; j <= side.pokemon.length; j++) {
				const pd = side.pokemon[j - 1];
				if (!pd || pd.active || pd.condition.endsWith(' fnt')) continue;
				benchSlots.push(j);
			}
			if (benchSlots.length) {
				const slot = this.bestSwitchSlot(request, benchSlots);
				const pd = side.pokemon[slot - 1];
				const d = trackerMod.parseDetails(`${pd.details}`);
				const sp = dex.speciesFromId(d.species);
				const view = {
					species: d.species,
					level: d.level,
					types: sp ? sp.types : [],
					moves: pd.moves || [],
					stats: pd.stats,
					hpRatio: (() => {
						const c = trackerMod.parseCondition(pd.condition);
						return c.maxHP ? c.curHP / c.maxHP : 0;
					})(),
				};
				const swScore = matchupScore(view, foeView) -
					SCORES.SWITCH_IN_PENALTY + view.hpRatio * 10;
				switchChoice = { slot, score: swScore };
				pushMove(`switch ${slot}`, 'switch', swScore, { switch: true });
			}
		}

		// --- pick ----------------------------------------------------------
		let best = candidates[0];
		for (const c of candidates) {
			if ((c.extraScore || 0) > (best.extraScore || 0)) best = c;
		}

		if (typeof best.slot === 'string' && best.slot.startsWith('switch')) {
			this.stats.switchesChosen++;
			return `switch ${best.slot.split(' ')[1]}`;
		}

		this.stats.movesChosen++;
		return `move ${best.slot}`;
	}

	/**
	 * Score non-damaging moves by their effect category.
	 */
	scoreStatusMove(mv, request, foeView) {
		const desc = `${mv.shortDesc || ''}`.toLowerCase();
		if (/raise.*spa|raise.*atk|raise.*spe|raise.*def/.test(desc) &&
			!/ally/.test(desc)) {
			return SCORES.STATUP_SELF; // setup moves
		}
		if (/heal/.test(desc)) return SCORES.HEAL_SELF;
		if (/(paralyz|sleep|burn|poison|freeze|toxic)/.test(desc)) {
			if (foeView && !foeView.status) return SCORES.STATUS_FOE;
			return 2;
		}
		if (/(stealth rock|spikes|toxic spikes|sticky web)/.test(desc)) {
			return SCORES.HAZARD;
		}
		if (/(protect|detect|spiky shield)/.test(desc)) return 6;
		if (/(roar|whirlwind|dragon tail)/.test(desc)) return 3;
		return 1; // generic utility
	}
}

module.exports = { HeuristicPlayerAI, matchupScore, SCORES };
