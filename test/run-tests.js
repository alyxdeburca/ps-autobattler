/**
 * Smoke tests for the auto-battler.
 * Run: node test/run-tests.js
 */
'use strict';

const assert = require('assert');
const trackerMod = require('../src/battle-state');
const est = require('../src/estimator');
const dex = require('../src/dex-shim');

let passed = 0;
function ok(name, fn) {
	try {
		fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (e) {
		console.error(`FAIL - ${name}\n   ${e.message}`);
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// Unit: parsing
// ---------------------------------------------------------------------------
ok('parseDetails extracts species + level', () => {
	const d = trackerMod.parseDetails('Garchomp, L81, M');
	assert.strictEqual(d.species, 'Garchomp');
	assert.strictEqual(d.level, 81);
	assert.strictEqual(d.gender, 'M');
});

ok('parseCondition handles hp/status/faint', () => {
	let c = trackerMod.parseCondition('82/120 PAR');
	assert.strictEqual(c.curHP, 82);
	assert.strictEqual(c.maxHP, 120);
	assert.strictEqual(c.status, 'par');
	c = trackerMod.parseCondition('100');
	assert.strictEqual(c.curHP, 100);
	assert.strictEqual(c.maxHP, 100);
	c = trackerMod.parseCondition('0 fnt');
	assert.ok(c.fnt && c.curHP === 0);
});

// ---------------------------------------------------------------------------
// Tracker: request merge + protocol lines
// ---------------------------------------------------------------------------
const REQUEST = {
	active: [{
		moves: [
			{ move: 'Earthquake', id: 'earthquake', pp: 96, maxpp: 96, target: 'allAdjacent' },
			{ move: 'Swords Dance', id: 'swordsdance', pp: 32, maxpp: 32 },
		],
		trapped: false,
	}],
	side: {
		id: 'p1',
		pokemon: [
			{
				ident: 'p1a: Garchomp',
				details: 'Garchomp, L81, M',
				condition: '253/253',
				active: true,
				stats: { atk: 182, def: 131, spa: 105, spd: 111, spe: 169 },
				moves: ['earthquake', 'swordsdance'],
				baseAbility: 'roughskin',
				item: 'leftovers',
				pokeball: 'pokeball',
			},
			{
				ident: 'p1b: Corviknight',
				details: 'Corviknight, L76, F',
				condition: '219/219',
				active: false,
				stats: { atk: 120, def: 145, spa: 78, spd: 92, spe: 87 },
				moves: ['bravebird', 'roost'],
				baseAbility: 'pressure',
				item: '',
				pokeball: 'pokeball',
			},
		],
	},
};

ok('tracker merges |request| into own team state', () => {
	const t = new trackerMod.BattleTracker('p1');
	t.seeRequest(REQUEST);
	assert.strictEqual(t.me.length, 2);
	const g = t.me[0];
	assert.strictEqual(g.species, 'Garchomp');
	assert.strictEqual(g.stats.atk, 182);
	assert.strictEqual(g.moves[0], 'earthquake');
	assert.ok(g.active);
});

ok('tracker follows foe switches and damage from public lines', () => {
	const t = new trackerMod.BattleTracker('p1');
	t.seeLine('|switch|p2a: Dragapult|Dragapult, L77, M|188/188');
	assert.strictEqual(t.foe.length, 1);
	assert.strictEqual(t.foeActive.species, 'Dragapult');

	t.seeLine('|-damage|p2a: Dragapult|94/188');
	assert.strictEqual(t.foeActive.hpRatio > 0.4 && t.foeActive.hpRatio < 0.6, true);

	t.seeLine('|move|p2a: Dragapult|Dragon Darts|[from]lockedmove');
	assert.ok(t.foeActive.moves.includes('dragondarts'));

	t.seeLine('|-status|p2a: Dragapult|tox');
	assert.strictEqual(t.foeActive.status, 'tox');

	t.seeLine('|switch|p2a: Gengar|Gengar, L78, M|200/200');
	assert.strictEqual(t.foeActive.species, 'Gengar');
	assert.strictEqual(t.foe.length, 2);
	assert.strictEqual(t.foe.find(p => p.name === 'Dragapult').active, false);
});

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------
dex.init('gen9randombattle');

ok('estimator: neutral hit lands in a sane range', () => {
	const attacker = {
		species: 'garchomp', level: 81,
		types: dex.speciesFromId('garchomp').types, status: '',
	};
	const move = dex.moveFromId('bodyslam'); // normal, physical, 80 BP
	// Gengar is Ghost-type: immune to Normal moves by typing.
	const dmg = est.expectedDamagePct({
		attacker,
		defender: { types: dex.speciesFromId('gengar').types, hpRatio: 1 },
		move,
		attackerStats: REQUEST.side.pokemon[0].stats,
		defenderSpecies: dex.speciesFromId('gengar'),
	});
	assert.strictEqual(dmg, 0, `expected immunity, got ${dmg}%`);

	const eq = dex.moveFromId('earthquake'); // ground, physical, 100 BP
	const dmg2 = est.expectedDamagePct({
		attacker,
		defender: { types: dex.speciesFromId('garchomp').types, hpRatio: 1 },
		move: eq,
		attackerStats: REQUEST.side.pokemon[0].stats,
		defenderSpecies: dex.speciesFromId('garchomp'),
	});
	// Neutral 100BP STAB-less vs itself: should be meaningful but not absurd.
	assert.ok(dmg2 > 10 && dmg2 < 80, `unexpected range: ${dmg2}%`);
});

ok('estimator: super effective & resisted differ correctly', () => {
	const attacker = { species: 'zapdos', level: 100, types: ['Electric'], status: '' };
	const stats = est.estimateStats(dex.speciesFromId('zapdos'), 100);
	const tbolt = dex.moveFromId('thunderbolt');
	const vsGyarados = est.expectedDamagePct({
		attacker, defender: { types: ['Water', 'Flying'], hpRatio: 1 },
		move: tbolt, attackerStats: stats,
		defenderSpecies: dex.speciesFromId('gyarados'),
	});
	const vsLanturn = est.expectedDamagePct({
		attacker, defender: { types: ['Water', 'Electric'], hpRatio: 1 },
		move: tbolt, attackerStats: stats,
		defenderSpecies: dex.speciesFromId('lanturn'),
	});
	// Gyarados (water/flying): double weak. Lanturn (water/electric): volt absorb-ish resist math -> 2x0.5=neutral... 
	assert.ok(vsGyarados > vsLanturn * 1.5,
		`SE ${vsGyarados.toFixed(1)}% should far exceed resisted ${vsLanturn.toFixed(1)}%`);
});

// ---------------------------------------------------------------------------

(async () => {
	const { runBattle } = require('../src/battle-runner');
	await dex.init('gen9randombattle');

	console.log('\nrunning integration battle...');
	const res = await runBattle({ formatid: 'gen9randombattle', p2: 'random' });
	console.log(`integration result: winner="${res.winner}" turns=${res.turns} time=${res.durationMs}ms`);
	if (!res.turns || res.winner === null) {
		console.error('FAIL - integration battle did not complete properly');
		process.exitCode = 1;
	} else {
		passed++;
		console.log('ok - integration battle completed');
	}
	console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
})();
