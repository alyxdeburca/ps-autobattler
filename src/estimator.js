/**
 * estimator.js
 *
 * Heuristic battle math for the auto-battler. Everything here is *estimation*
 * from public information: we don't peek at hidden foe stats, we approximate
 * them (level-100 neutral nature, standard spreads) the way a good human
 * player would.
 */
'use strict';

const dex = require('./dex-shim');

const STATUS_MULTIPLIERS = {
	brn: 0.5,  // burn halves physical damage
	psn: 1,
	tox: 1,
	par: 1,
	slp: 1,
	frz: 1,
};

// Optional high-fidelity calc engine (e.g. @smogon/calc in the browser
// extension). Signature: ({attacker, defender, move, attackerStats,
// defenderSpecies}) -> expected damage as % of defender max HP.
let calcEngine = null;

function setCalcEngine(fn) {
	calcEngine = typeof fn === 'function' ? fn : null;
}

function getCalcEngine() {
	return calcEngine;
}

/** Estimate level-100 stats for a species when we can't see real ones
 *  (i.e. for foe pokemon). Uses a neutral nature + generic EV spread. */
function estimateStats(species, level = 100) {
	const base = species.baseStats;
	const est = {};
	// Generic "competitive-ish" spread assumption: 85 EVs everywhere.
	const evFactor = (85 / 255) * 0.1; // ~3.3 points at level 100
	for (const s of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
		if (s === 'hp') {
			est.hp = Math.floor((2 * base.hp + 31 + 21) * level / 100) + level + 10;
		} else {
			est[s] = Math.floor((2 * base[s] + 31 + Math.floor(evFactor * 255)) * level / 100) + 5;
		}
	}
	return est;
}

/** Rough STAB bonus factor: 1.5 if move type matches one of the user's types. */
function stabFactor(moveType, userTypes) {
	return userTypes && userTypes.includes(moveType) ? 1.5 : 1;
}

/** Type effectiveness multiplier against defender types (handles Tera retype). */
function typeMultiplier(moveType, defTypes) {
	let mult = 1;
	for (const t of defTypes) {
		const eff = dex.getEffectiveness(moveType, [t]);
		if (eff > 0) mult *= 2;
		else if (eff < 0) mult *= 0.5;
	}
	if (dex.isImmune(moveType, defTypes)) mult = 0;
	return mult;
}

/** Gen 5+ damage formula (approximate; returns expected damage). */
function damageFormula(level, power, A, D, mults) {
	const base = Math.floor(Math.floor(
		(2 * level / 5 + 2) * power * A / D
	) / 50) + 2;
	// NOTE: no `|| 1` fallbacks here -- a 0 type multiplier means IMMUNE,
	// and `0 || 1` would wrongly evaluate to 1.
	return base * mults.stab * mults.type * mults.burn * mults.screen * mults.weather;
}

/**
 * Estimate the damage a move does (as % of defender max HP).
 *
 * @param {object} opts
 *   attacker   : {species, level, types, status} - user's mon (exact data)
 *   defender   : {types, hpRatio}                - foe view
 *   move       : Showdown Move object (from dex)
 *   attackerStats : real StatsTable (we know our own)
 *   defenderSpecies : foe Species object
 */
function estimateDamagePct({ attacker, defender, move, attackerStats, defenderSpecies }) {
	if (!move || !defenderSpecies) return 0;

	const defTypes = defender.types || defenderSpecies.types;
	const moveType = move.type;
	const category = move.category; // 'Physical' | 'Special' | 'Status'

	if (category === 'Status') return 0;

	const defLevel = defender.level || 100;
	const defStats = estimateStats(defenderSpecies, defLevel);

	// OHKO moves: treat as instant kill.
	if (move.ohko) return 100;

	const isPhysical = category === 'Physical';
	let A = isPhysical ? attackerStats.atk : attackerStats.spa;
	let D = isPhysical ? defStats.def : defStats.spd;

	if (isPhysical && attacker.status === 'brn') A *= STATUS_MULTIPLIERS.brn;

	const level = attacker.level || 100;
	let power = move.basePower;

	// Fixed-damage moves (Seismic Toss etc.): move.damage is a plain number.
	if (!power && typeof move.damage === 'number') {
		return Math.min(100, (move.damage / defStats.hp) * 100);
	}

	if (!power) return 0; // e.g. counter/mirror coat style or unusual mechanics

	const mults = {
		stab: stabFactor(moveType, attacker.types),
		type: typeMultiplier(moveType, defTypes),
		burn: 1,
		screen: 1,
		weather: 1,
	};
	// Light Screen / Reflect reduce damage by half while active (rough).
	if (defender.screenActive) mults.screen = 0.5;

	let dmg = damageFormula(level, power, A, D, mults);

	// Multi-hit moves average ~3 hits.
	if (move.multihit) dmg *= 3;

	return (dmg / defStats.hp) * 100;
}

/** Expected damage % after accuracy. Used for scoring. */
function expectedDamagePct(opts) {
	if (calcEngine) {
		try {
			const v = calcEngine(opts);
			if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
		} catch (e) {
			// Engine failure must never break decisions -- fall through to
			// the internal heuristic below.
		}
	}
	const raw = estimateDamagePct(opts);
	const acc = (opts.move && opts.move.accuracy === true) ? 1 :
		((opts.move && opts.move.accuracy) || 100) / 100;
	return raw * acc;
}

module.exports = {
	estimateStats,
	estimateDamagePct,
	expectedDamagePct,
	stabFactor,
	typeMultiplier,
	setCalcEngine,
	getCalcEngine,
	STATUS_MULTIPLIERS,
};
