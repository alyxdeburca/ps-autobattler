'use strict';
const trackerMod = require('../src/battle-state');
const est = require('../src/estimator');
const dex = require('../src/dex-shim');

const REQUEST = {
	side: { pokemon: [ { stats: { atk: 182, def: 131, spa: 105, spd: 111, spe: 169 } } ] },
};
dex.init('gen9randombattle');
const attacker = {
	species: 'garchomp', level: 81,
	types: dex.speciesFromId('garchomp').types, status: '',
};
const move = dex.moveFromId('bodyslam');
console.log('move:', move.id, move.type, move.basePower, move.category);
const defTypes = dex.speciesFromId('gengar').types;
console.log('defTypes:', defTypes);
console.log('isImmune:', dex.isImmune(move.type, defTypes));
console.log('mult:', est.typeMultiplier(move.type, defTypes));
const dmg = est.expectedDamagePct({
	attacker,
	defender: { types: defTypes, hpRatio: 1 },
	move,
	attackerStats: REQUEST.side.pokemon[0].stats,
	defenderSpecies: dex.speciesFromId('gengar'),
});
console.log('dmg:', dmg);
