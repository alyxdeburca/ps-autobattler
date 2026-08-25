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
	SWITCH_IN_PENALTY: 14,
	LOW_PP: -3,
	/** Switching must beat the best stay-in move by this margin. */
	SWITCH_MARGIN: 6,
	/** Penalty for flipping back to a slot we recently switched away from. */
	FLIP_PENALTY: 12,
	FLIP_WINDOW_TURNS: 2,
	/** Tera must beat the non-tera version of the same move by this much. */
	TERA_MARGIN: 25,
};

/** Per-battle AI memory hung off the tracker instance. */
function aiMem(tracker) {
	if (!tracker._aiMem) {
		tracker._aiMem = { switchHistory: [], statusUse: new Map(), setupStreak: 0 };
	}
	return tracker._aiMem;
}

/**
 * Diminishing returns for repeating the same status move: each consecutive
 * use halves the value (healing/setup loops are how bots lose).
 */
function repetitionFactor(mem, moveId, isSetupOrHeal) {
	if (!isSetupOrHeal) return 1;
	const n = mem.statusUse.get(moveId) || 0;
	return Math.pow(0.5, n);
}

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

/** Type-based immunities of common status moves (beyond move-type chart). */
const STATUS_IMMUNE_TYPES = {
	thunderwave: ['Ground', 'Electric'],
	stunspore: ['Ground', 'Electric'],
	glare: [],
	toxic: ['Steel', 'Poison'],
	poisonpowder: ['Steel', 'Poison', 'Grass'],
	willowisp: ['Fire'],
};

function statusApplicable(mv, defTypes) {
	if (!defTypes || !defTypes.length) return true;
	const blocked = STATUS_IMMUNE_TYPES[mv.id];
	if (blocked && blocked.some(t => defTypes.includes(t))) return false;
	// Move-type immunity (TWave=Electric vs Ground, Toxic=Poison vs Steel…)
	if (dex.isImmune(mv.type, defTypes)) return false;
	return true;
}

/**
 * Score a status move in CONTEXT. Status is an investment: its value is
 * capped by the damage tempo we give up by clicking it.
 *
 * ctx: { foeView, selfHpRatio, bestDmg, canKoNow, twoHitKo, seenFoes }
 */
function scoreStatusMove(mv, ctx) {
	const desc = `${mv.shortDesc || ''}`.toLowerCase();
	const foeView = ctx.foeView;

	if (/raise.*spa|raise.*atk|raise.*spe|raise.*def/.test(desc) &&
		!/ally/.test(desc)) {
		// Setup: worthless if we can KO now, discounted when frail,
		// endgame, or already hitting like a truck.
		if (ctx.canKoNow) return 2;
		let v = SCORES.STATUP_SELF;
		if (ctx.selfHpRatio < 0.45) v *= 0.4;
		if (ctx.seenFoes <= 2) v *= 0.6;
		if (ctx.bestDmg >= 90) v *= 0.3;
		return v;
	}

	if (/heal/.test(desc)) {
		// Recovery is worth roughly the HP it restores; healthy = wasted turn.
		if (ctx.selfHpRatio >= 0.72) return 1;
		return Math.min(34, 50 * (1 - ctx.selfHpRatio));
	}

	if (/(paralyz|sleep|burn|poison|freeze|toxic)/.test(desc)) {
		if (foeView && foeView.status) return 2;         // already statused
		if (foeView && !statusApplicable(mv, foeView.types)) return 0.5;
		if (ctx.canKoNow) return 1;                      // never waste a KO
		// Cap at ~one turn of our best damage; attacking twice beats fishing
		// for status when we're close to the KO anyway.
		let v = Math.min(SCORES.STATUS_FOE, Math.max(6, ctx.bestDmg));
		if (ctx.twoHitKo) v *= 0.45;
		return v;
	}

	if (/(stealth rock|spikes|toxic spikes|sticky web)/.test(desc)) {
		if (ctx.canKoNow) return 1;
		return ctx.seenFoes <= 2 ? 4 : SCORES.HAZARD;
	}

	if (/(protect|detect|spiky shield)/.test(desc)) return 3;
	if (/(roar|whirlwind|dragon tail)/.test(desc)) return 2;
	return 1; // generic utility
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
		boosts: (tracker._selfBoosts) || {},
	};
	const defenderSpecies = foeView ? dex.speciesFromId(foeView.species) : null;

	// Context for status-move scoring: tempo math.
	const selfHpRatio = hpRatioOf(activePd.condition);
	let bestDmgPct = 0;
	for (const md of meActive.moves) {
		if (md.disabled) continue;
		const mv = dex.moveFromId(md.id);
		if (!mv || mv.category === 'Status') continue;
		bestDmgPct = Math.max(bestDmgPct, est.expectedDamagePct({
			attacker, defender: foeView || {}, move: mv,
			attackerStats: activePd.stats,
			defenderSpecies,
		}));
	}
	const ctx = {
		foeView,
		selfHpRatio,
		bestDmg: bestDmgPct,
		canKoNow: foeView ? bestDmgPct >= 100 : false,
		twoHitKo: foeView ? bestDmgPct >= (foeView.hpRatio || 1) * 50 : false,
		seenFoes: tracker.foe ? tracker.foe.filter(f => f && !f.fainted).length : 0,
	};
	const teraType = meActive.canTerastallize || '';
	const mem = aiMem(tracker);

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
			score = scoreStatusMove(mv, ctx);
			// Setup/heal loops die here: each repeat halves the score, and
			// a long setup streak is hard-capped.
			const isSetup = /raise/.test(`${mv.shortDesc || ''}`.toLowerCase());
			const isHeal = /heal/.test(`${mv.shortDesc || ''}`.toLowerCase());
			if (isSetup || isHeal) {
				score *= repetitionFactor(mem, md.id, true);
				if (isSetup && mem.setupStreak >= 2) score = Math.min(score, 1);
				if (score <= ctx.bestDmg) score = Math.min(score, ctx.bestDmg * 0.6);
			}
		}
		if (mv.secondary && mv.secondary.status && foeView &&
			!foeView.status && dmg > 0) {
			score += SCORES.STATUS_FOE * (mv.secondary.chance || 100) / 200;
		}
		if ((md.pp | 0) === 1) score += SCORES.LOW_PP;

		candidates.push({ kind: 'move', slot: idx + 1, id: md.id, name: mv.name, score, dmg });

		// --- Tera variant: worth spending only if it clearly pays --------
		if (teraType && mv.category !== 'Status') {
			const teraAttacker = { ...attacker, teraType, willTera: true };
			const dmgT = est.expectedDamagePct({
				attacker: teraAttacker, defender: foeView || {}, move: mv,
				attackerStats: activePd.stats,
				defenderSpecies,
			});
			let tScore = dmgT;
			if (dmgT >= 100) tScore += SCORES.OHKO;
			else if (foeView && dmgT >= (foeView.hpRatio || 1) * 100) tScore += 30;
			const enablesKo = dmgT >= 100 && dmg < 100;
			if (!enablesKo && tScore <= score + SCORES.TERA_MARGIN) tScore = -1;
			candidates.push({
				kind: 'tera-move', slot: idx + 1, id: md.id,
				name: `${mv.name} ✦`, score: tScore, dmg: dmgT, teraType,
			});
		}
	});

	// --- switch --------------------------------------------------------
	const trapped = meActive.trapped || meActive.maybeTrapped;
	const activeSlot = side.pokemon.findIndex(p => p.active) + 1;
	if (!trapped) {
		const benchSlots = [];
		for (let j = 1; j <= side.pokemon.length; j++) {
			const pd = side.pokemon[j - 1];
			if (!pd || pd.active || pd.condition.endsWith(' fnt')) continue;
			benchSlots.push(j);
		}
		if (benchSlots.length) {
			for (const slot of benchSlots) {
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
				let swScore = matchupScore(view, foeView) -
					SCORES.SWITCH_IN_PENALTY + view.hpRatio * 10;
				// Anti-dithering: flipping back to the mon we just switched
				// away from (within the window) costs extra.
				const recent = mem.switchHistory[mem.switchHistory.length - 1];
				const flippedBack = recent &&
					recent.from === slot &&
					tracker.turn - recent.turn <= SCORES.FLIP_WINDOW_TURNS;
				if (flippedBack) swScore -= SCORES.FLIP_PENALTY;
				candidates.push({
					kind: 'switch', slot,
					id: d.species, name: sp ? sp.name : d.species,
					score: swScore, flippedBack: !!flippedBack,
				});
			}
		}
	}

	let best = candidates[0] || null;
	for (const c of candidates) {
		if ((c.score || 0) > (best.score || 0)) best = c;
	}

	// Switching must clearly beat staying in; otherwise attack.
	const moveScores = candidates.filter(c => c.kind === 'move').map(c => c.score);
	const bestMoveScore = moveScores.length ? Math.max(...moveScores) : -Infinity;
	if (best && best.kind === 'switch' &&
		best.score < bestMoveScore + SCORES.SWITCH_MARGIN) {
		best = candidates.find(c => c.kind === 'move' && c.score === bestMoveScore) || best;
	}

	// Record voluntary switches so future turns recognize flip-backs.
	if (best && best.kind === 'switch') {
		mem.switchHistory.push({ from: activeSlot, to: best.slot, turn: tracker.turn });
		if (mem.switchHistory.length > 8) mem.switchHistory.shift();
	}

	// Update status/setup memory for repetition damping + streak caps.
	if (best && best.kind === 'move') {
		const isSetup = /raise/.test(`${(dex.moveFromId(best.id) || {}).shortDesc || ''}`.toLowerCase());
		const isHeal = /heal/.test(`${(dex.moveFromId(best.id) || {}).shortDesc || ''}`.toLowerCase());
		if (isSetup || isHeal) mem.statusUse.set(best.id, (mem.statusUse.get(best.id) || 0) + 1);
		mem.setupStreak = isSetup ? mem.setupStreak + 1 : 0;
	} else if (best) {
		mem.setupStreak = 0;
	}

	const choice = !best ? 'default'
		: best.kind === 'switch' ? `switch ${best.slot}`
		: best.kind === 'tera-move' ? `move ${best.slot} terastallize`
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
