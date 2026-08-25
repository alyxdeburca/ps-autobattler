/**
 * decision-core.js
 *
 * Pure battle decision logic, decoupled from any transport (no streams, no
 * BattlePlayer). Consumed by:
 *   - heuristic-ai.js (headless battles, this repo)
 *   - the Chrome extension (live battles on play.pokemonshowdown.com)
 *
 * Depends only on: battle-state (tracking helpers), estimator, dex-shim.
 */
'use strict';

const trackerMod = require('./battle-state');
const dex = require('./dex-shim');
const est = require('./estimator');

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
	SWITCH_IN_PENALTY: 6,
	LOW_PP: -3,
};

/** Value of bringing `monView` in against the current active foe. */
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
	// Offensive: best expected damage across known moves.
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

/** Score non-damaging moves by their effect category. */
function scoreStatusMove(mv, foeView) {
	const desc = `${mv.shortDesc || ''}`.toLowerCase();
	if (/raise.*spa|raise.*atk|raise.*spe|raise.*def/.test(desc) &&
		!/ally/.test(desc)) {
		return SCORES.STATUP_SELF;
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
	return 1;
}

function hpRatioOf(condition) {
	const c = trackerMod.parseCondition(String(condition));
	return c.maxHP ? c.curHP / c.maxHP : 0;
}

/** Pick the best bench slot among candidateSlots given the request side data. */
function bestSwitchSlot(request, candidateSlots, foeView) {
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
			hpRatio: hpRatioOf(pd.condition),
		};
		const score = matchupScore(view, foeView) + view.hpRatio * 10;
		if (score > bestScore) { bestScore = score; best = slot; }
	}
	return best;
}

/**
 * Decide actions when the game forces switches (fainted mons).
 * Returns a choice string like "switch 3, pass".
 */
function decideForceSwitch(tracker, request) {
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
			if (!(j > musts.length || reviving)) continue;
			if (chosen.includes(j)) continue;
			const fainted = pd.condition.endsWith(' fnt');
			if (!fainted !== !reviving) continue;
			options.push(j);
		}
		if (!options.length) { choices.push('pass'); continue; }
		const best = bestSwitchSlot(request, options, tracker.foeView());
		chosen.push(best);
		choices.push(`switch ${best}`);
	}
	return choices.join(', ');
}

/**
 * Main decision: given tracked state + the move request, return
 * `{ choice, candidates }` where candidates are scored options (debug/UI).
 */
function decideMove(tracker, request) {
	const meActive = request.active[0];
	const side = request.side;
	const activePd = side.pokemon.find(p => p.active) || side.pokemon[0];

	const foeView = tracker.foeView();
	const attackerSpecies = activePd.details.split(', ')[0];
	const myTypes = (() => {
		const sp = dex.speciesFromId(attackerSpecies);
		return sp ? sp.types : [];
	})();
	const attacker = {
		species: attackerSpecies,
		level: (trackerMod.parseDetails(`${activePd.details}`)).level,
		types: myTypes,
		status: trackerMod.parseCondition(activePd.condition).status,
		item: activePd.item || '',
	};
	const defenderSpecies = foeView ? dex.speciesFromId(foeView.species) : null;

	const candidates = [];

	// --- moves ---------------------------------------------------------
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
		else if (foeView && dmg >= foeView.hpRatio * 100) score += 30;
		else if (dmg < 15 && mv.category === 'Status') score -= 5;

		if (mv.category === 'Status') {
			score = scoreStatusMove(mv, foeView);
		}
		if (mv.secondary && mv.secondary.status && foeView &&
			!foeView.status && dmg > 0) {
			score += SCORES.STATUS_FOE * (mv.secondary.chance || 100) / 200;
		}
		if ((md.pp | 0) === 1) score += SCORES.LOW_PP;

		candidates.push({ kind: 'move', slot: idx + 1, id: md.id, name: mv.name, score, dmg });
	});

	// --- switch --------------------------------------------------------
	const trapped = meActive.trapped || meActive.maybeTrapped;
	if (!trapped) {
		const benchSlots = [];
		for (let j = 1; j <= side.pokemon.length; j++) {
			const pd = side.pokemon[j - 1];
			if (!pd || pd.active || pd.condition.endsWith(' fnt')) continue;
			benchSlots.push(j);
		}
		if (benchSlots.length) {
			const slot = bestSwitchSlot(request, benchSlots, foeView);
			const pd = side.pokemon[slot - 1];
			const d = trackerMod.parseDetails(`${pd.details}`);
			const sp = dex.speciesFromId(d.species);
			const view = {
				species: d.species,
				level: d.level,
				types: sp ? sp.types : [],
				moves: pd.moves || [],
				stats: pd.stats,
				hpRatio: hpRatioOf(pd.condition),
			};
			const swScore = matchupScore(view, foeView) -
				SCORES.SWITCH_IN_PENALTY + view.hpRatio * 10;
			candidates.push({ kind: 'switch', slot, id: d.species, name: sp ? sp.name : d.species, score: swScore });
		}
	}

	let best = candidates[0] || null;
	for (const c of candidates) {
		if ((c.score || 0) > (best.score || 0)) best = c;
	}
	const choice = !best ? 'default'
		: best.kind === 'switch' ? `switch ${best.slot}`
		: `move ${best.slot}`;
	return { choice, candidates, best };
}

module.exports = {
	SCORES,
	matchupScore,
	scoreStatusMove,
	bestSwitchSlot,
	decideForceSwitch,
	decideMove,
};
