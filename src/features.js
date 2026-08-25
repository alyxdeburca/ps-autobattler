/**
 * src/features.js
 *
 * Encodes a decision point (tracker + request + candidate) into a flat
 * numeric feature vector for the policy net. Same code path must be usable
 * in Node (training) and browser (inference) -- no Node APIs here.
 */
'use strict';

const dex = require('./dex-shim');
const trackerMod = require('./battle-state');

// Feature layout (documented for reproducibility):
//   [0]   turn / 30
//   [1..6]   my active: hp%, atk, def, spa, spd, spe  (stats/300)
//   [7]      my active status onehot-ish (0 none, .25 par, .5 brn, .75 psn/tox, 1 slp/frz)
//   [8..13]  foe active: same block
//   [14]     foe hp%
//   [15]     foe status
//   [16..21] my team hp% per slot (up to 6; fainted=0)
//   [22..27] bench alive flags (1/0)
//   [28..33] foe revealed count per slot? -> simplified: foes seen /6, fainted /6,
//            my fainted /6, my remaining /6, foe boosts atk/spa norm, self boosts atk/spa norm
const F = 34;

function statusNum(s) {
	return { '': 0, par: 0.25, brn: 0.5, psn: 0.5, tox: 0.75, slp: 1, frz: 1 }[s || ''] || 0;
}

function monBlock(mon, statsFallback) {
	const out = [];
	const sp = dex.speciesFromId(mon.species || '');
	const stats = mon.stats || statsFallback ||
		require('./estimator').estimateStats(sp || { baseStats: { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 } }, mon.level || 100);
	out.push(mon.hpRatio != null ? mon.hpRatio : 1);
	for (const s of ['atk', 'def', 'spa', 'spd', 'spe']) {
		out.push(Math.min(2, (stats[s] || 100) / 200));
	}
	return out;
}

/**
 * @param {BattleTracker} tracker
 * @param {object} request adapted move-request
 * @param {object} candidate {kind, slot, dmg, score}
 */
function encode(tracker, request, candidate) {
	const v = new Array(F).fill(0);
	v[0] = Math.min(1, (tracker.turn || 0) / 30);

	const me = tracker.myActive;
	const foe = tracker.foeActive;

	if (me) {
		const b = monBlock(me);
		b.unshift(me.hpRatio != null ? me.hpRatio : 1);
		// monBlock already starts with hpRatio; avoid double-add:
		b.shift();
		for (let i = 0; i < 6; i++) v[1 + i] = b[i] ?? 0;
		v[7] = statusNum(me.status);
	}
	if (foe) {
		const b = monBlock(foe);
		for (let i = 0; i < 6; i++) v[8 + i] = b[i] ?? 0;
		v[14] = foe.hpRatio != null ? foe.hpRatio : 1;
		v[15] = statusNum(foe.status);
	}

	const side = request.side;
	const n = Math.min(6, side.pokemon.length);
	let faintedMine = 0;
	for (let i = 0; i < 6; i++) {
		if (i >= n) break;
		const pd = side.pokemon[i];
		const c = trackerMod.parseCondition(String(pd.condition));
		const ratio = c.maxHP ? c.curHP / c.maxHP : 0;
		v[16 + i] = pd.active ? (me ? me.hpRatio : ratio) : ratio;
		if (c.fnt) faintedMine++;
		v[22 + i] = (!c.fnt && !pd.active) ? 1 : 0;
	}
	v[28] = tracker.foe.length / 6;
	v[29] = tracker.foe.filter(f => f.fainted).length / 6;
	v[30] = faintedMine / 6;
	v[31] = (n - faintedMine) / 6;
	const fb = tracker._foeBoosts || {};
	v[32] = ((fb.atk || 0) + (fb.spa || 0)) / 12;
	const sb = tracker._selfBoosts || {};
	v[33] = ((sb.atk || 0) + (sb.spa || 0)) / 12;

	// Candidate-specific channels overwrite the tail of the vector:
	// kind flags + damage estimate.
	v[3] = candidate.kind === 'switch' ? 1 : 0;          // reuse slot-3 as switch flag
	v[4] = candidate.kind === 'tera-move' ? 1 : 0;       // tera flag
	v[5] = Math.min(2, (candidate.dmg || 0) / 100);       // est dmg of THIS action
	v[6] = Math.min(1, ((candidate.slot || 1) - 1) / 5);  // slot index normalized

	return v;
}

module.exports = { encode, FEATURES: F };
