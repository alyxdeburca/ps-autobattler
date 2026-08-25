/**
 * battle-state.js
 *
 * Tracks what a fair player knows during a battle, purely from their own
 * side-update stream (plus public update lines). This mirrors what a human
 * player sees in the Showdown client:
 *
 *   - your own team: exact HP / status / stats / moves (from `|request|`)
 *   - the foe team : species, types, level, %HP, visible status/moves/items
 *                    (parsed from `|switch|`, `|move|`, `|-damage|`, etc.)
 */
'use strict';

/** Split a Showdown "details" string ("Garchomp, L81, M") into parts. */
function parseDetails(details) {
	const [species, ...rest] = details.split(', ');
	let level = 100;
	let shiny = false;
	let gender = '';
	for (const part of rest) {
		if (/^L\d+$/.test(part)) level = parseInt(part.slice(1), 10);
		else if (part === 'shiny') shiny = true;
		else if (['M', 'F'].includes(part)) gender = part;
	}
	return { species, level, shiny, gender };
}

/** Parse a condition string like "82/120 PAR", "45/100", "0 fnt" or "100". */
function parseCondition(cond) {
	const fnt = cond.endsWith(' fnt');
	const body = fnt ? cond.slice(0, -4) : cond;
	const [hpPart, statusPart] = body.split(' ');
	let curHP = null, maxHP = null;
	if (hpPart.includes('/')) {
		[curHP, maxHP] = hpPart.split('/').map(v => parseInt(v, 10));
	} else {
		curHP = maxHP = parseInt(hpPart, 10); // percentage-only view (opponent)
	}
	return { curHP, maxHP, status: statusPart || '', fnt };
}

/** Extract the bare pokemon id from "p2a: Garchomp" -> "p2a" plus owner side. */
function parseIdent(ident) {
	const [posid, name] = ident.split(': ');
	const side = posid.slice(0, 2);
	return { posid, side, name };
}

class TrackedPokemon {
	constructor(ident, details, condition) {
		const d = parseDetails(details);
		this.name = ident.split(': ')[1] || d.species;
		this.species = d.species;
		this.level = d.level;
		this.conditionText = condition;
		const c = parseCondition(condition);
		this.curHP = c.curHP;
		this.maxHP = c.maxHP;
		this.status = c.status;
		this.fainted = c.fnt;
		this.types = [];
		this.moves = [];        // ids seen used by this pokemon
		this.item = '';         // revealed item (knocked off / eaten berries / chosen)
		this.ability = '';      // revealed ability
		this.teraType = '';     // revealed Tera type
		this.terastallized = false;
	}

	get hpRatio() {
		return this.maxHP ? this.curHP / this.maxHP : 0;
	}

	updateCondition(condition) {
		this.conditionText = condition;
		const c = parseCondition(condition);
		// Opponent views are percentages; keep ratio consistent across updates.
		if (!c.fnt && this.maxHP && c.maxHP && c.maxHP !== this.maxHP) {
			// rescale (e.g. first view gave 100/100, later 250/250)
			const scale = this.maxHP / c.maxHP;
			this.curHP = Math.round(c.curHP * scale);
		} else if (!this.maxHP && c.maxHP) {
			this.maxHP = c.maxHP;
		} else {
			this.curHP = c.curHP;
		}
		this.status = c.status;
		this.fainted = c.fnt;
		if (c.fnt) this.curHP = 0;
	}
}

class BattleTracker {
	constructor(mySide) {
		this.mySide = mySide;                 // 'p1' or 'p2'
		this.turn = 0;
		this.me = [];                         // TrackedPokemon[] (rich, from requests)
		this.foe = [];                        // TrackedPokemon[] (public knowledge only)
		this.foeActiveName = null;
		this.field = { weather: '', terrain: '' };
		this.lastFoeMove = '';
	}

	activeMon(list) {
		return list.find(p => !p.fainted && p.active) || list.find(p => !p.fainted) || null;
	}

	get myActive() { return this.activeMon(this.me); }
	get foeActive() { return this.activeMon(this.foe); }

	/** Feed one protocol line (without leading |) from either the player's own
	 *  sideupdate or the public update channel. */
	seeLine(line) {
		if (!line.startsWith('|')) return;
		const parts = line.slice(1).split('|');
		const cmd = parts[0];
		switch (cmd) {
		case 'turn': this.turn = parseInt(parts[1], 10) || this.turn; break;
		case 'switch': case 'drag': {
			const [, ident, details, condition] = parts;
			const { side } = parseIdent(ident);
			const list = side === this.mySide ? this.me : this.foe;
			let mon = list.find(p => p.name === ident.split(': ')[1]);
			if (!mon) {
				mon = new TrackedPokemon(ident, details, condition);
				list.push(mon);
			} else {
				mon.updateCondition(condition);
			}
			mon.active = true;
			for (const p of list) if (p !== mon) p.active = false;
			break;
		}
		case 'replace': {
			// Illusion ended: swap the species/details of the active foe mon.
			const [, ident, details] = parts;
			const { side, name } = parseIdent(ident);
			if (side === this.mySide) break;
			const mon = this.foeActive;
			const d = parseDetails(details);
			if (mon) {
				mon.name = name;
				mon.species = d.species;
				mon.level = d.level;
			}
			break;
		}
		case '-damage': {
			const [, ident, condition] = parts;
			const { side } = parseIdent(ident);
			const list = side === this.mySide ? this.me : this.foe;
			const mon = list.find(p => p.name === ident.split(': ')[1]) || this.activeMon(list);
			if (mon) mon.updateCondition(condition);
			break;
		}
		case '-heal': {
			const [, ident, condition] = parts;
			const { side } = parseIdent(ident);
			const list = side === this.mySide ? this.me : this.foe;
			const mon = list.find(p => p.name === ident.split(': ')[1]) || this.activeMon(list);
			if (mon) mon.updateCondition(condition);
			break;
		}
		case '-status': {
			const [, ident, status] = parts;
			const { side } = parseIdent(ident);
			const list = side === this.mySide ? this.me : this.foe;
			const mon = list.find(p => p.name === ident.split(': ')[1]) || this.activeMon(list);
			if (mon) mon.status = status;
			break;
		}
		case '-curestatus': {
			const [, ident] = parts;
			const { side } = parseIdent(ident);
			const list = side === this.mySide ? this.me : this.foe;
			const mon = list.find(p => p.name === ident.split(': ')[1]) || this.activeMon(list);
			if (mon) mon.status = '';
			break;
		}
		case 'move': {
			const [, ident, moveName] = parts;
			const { side } = parseIdent(ident);
			if (side === this.mySide) break;
			this.lastFoeMove = moveName;
			const mon = this.activeMon(this.foe);
			if (mon) {
				const id = moveName.toLowerCase().replace(/[^a-z0-9]+/g, '');
				if (!mon.moves.includes(id)) mon.moves.push(id);
				// Hidden Power's actual type arrives as a detail: [from] Hidden Power Fire
			}
			break;
		}
		case '-ability': {
			const [, ident, ability] = parts;
			const { side } = parseIdent(ident);
			const list = side === this.mySide ? this.me : this.foe;
			const mon = list.find(p => p.name === ident.split(': ')[1]) ||
				(side === this.mySide ? this.myActive : this.foeActive);
			if (mon && side !== this.mySide) mon.ability = ability;
			break;
		}
		case '-item': {
			const [, ident, item] = parts;
			const { side } = parseIdent(ident);
			const list = side === this.mySide ? this.me : this.foe;
			const mon = list.find(p => p.name === ident.split(': ')[1]) ||
				(side === this.mySide ? this.myActive : this.foeActive);
			if (mon && side !== this.mySide) mon.item = item;
			break;
		}
		case '-enditem': {
			const [, ident, item] = parts;
			const { side } = parseIdent(ident);
			if (side === this.mySide) break;
			const mon = this.foeActive;
			if (mon) mon.item = '';
			break;
		}
		case '-mega': case '-burst': case '-primal': {
			// |-mega|p2a: Charizard|Charizard, L75|charizardmegax
			const [, ident, , speciesId] = parts;
			const { side } = parseIdent(ident);
			if (side === this.mySide) break;
			const mon = this.foeActive;
			if (mon) {
				const sp = require('./dex-shim').speciesFromId(speciesId);
				if (sp) mon.species = sp.name;
				if (sp) mon.types = sp.types.slice();
			}
			break;
		}
		case '-formechange': {
			const [, ident, , , fromSpecies, toSpecies] = parts;
			const { side } = parseIdent(ident);
			if (side === this.mySide) break;
			const mon = this.foeActive;
			if (mon && toSpecies) {
				const sp = require('./dex-shim').speciesFromId(toSpecies);
				if (sp) {
					mon.species = sp.name;
					mon.types = sp.types.slice();
				}
			}
			break;
		}
		case '-terastallize': {
			const [, ident, teraType] = parts;
			const { side } = parseIdent(ident);
			const list = side === this.mySide ? this.me : this.foe;
			const mon = this.activeMon(list);
			if (mon) {
				mon.terastallized = true;
				mon.teraType = teraType.replace('Terastallize ', '').trim();
				if (side !== this.mySide) mon.types = [mon.teraType];
			}
			break;
		}
		case '-weather': {
			const weather = parts[1];
			this.field.weather = (weather === 'none') ? '' : weather;
			break;
		}
		case '-fieldstart': {
			const terrain = parts[1].split(':')[0].trim().toLowerCase().replace(/[^a-z]/g, '');
			this.field.terrain = terrain === 'none' ? '' : terrain;
			break;
		}
		case '-fieldend': {
			this.field.terrain = '';
			break;
		}
		case '-sidestart': {
			// hazards on a side: |-sidestart|p2: side|Stealth Rock
			break; // hazard tracking is a future refinement
		}
		default:
			break;
		}
	}

	/** Merge a full `|request|` payload for MY side into tracker state. */
	seeRequest(request) {
		if (!request || request.wait) return;
		const side = request.side;
		if (!side) return;
		for (let i = 0; i < side.pokemon.length; i++) {
			const pd = side.pokemon[i];
			let mon = this.me[i];
			if (!mon) {
				mon = new TrackedPokemon(pd.ident, `${pd.details}`, pd.condition);
				this.me[i] = mon;
			}
			mon.name = pd.ident.split(': ')[1];
			mon.details = pd.details;
			const d = parseDetails(`${pd.details}`);
			mon.species = d.species;
			mon.level = d.level;
			mon.updateCondition(pd.condition);
			// Exact private info:
			mon.stats = { ...pd.stats };          // real atk/def/spa/spd/spe
			mon.moves = [...pd.moves];            // real move ids
			mon.item = pd.item || mon.item;       // own item is known
			mon.baseAbility = pd.baseAbility || '';
			mon.ability = pd.ability || mon.baseAbility;
			mon.active = pd.active;
			mon.reviving = !!pd.reviving;
			mon.commanding = !!pd.commanding;
			// Types from the dex (own mon: fully known)
			const sp = require('./dex-shim').speciesFromId(d.species);
			if (sp) mon.types = sp.types.slice();
		}
		// Active move availability lives on request.active[] aligned with active mons.
		if (request.active) {
			let idx = 0;
			for (const mon of this.me) {
				if (!mon.active) continue;
				const act = request.active[idx++];
				if (!act) continue;
				mon.trapped = !!act.trapped;
				mon.maybeTrapped = !!act.maybeTrapped;
				mon.canMegaEvo = !!act.canMegaEvo;
				mon.canDynamax = !!act.canDynamax;
				mon.canTerastallize = act.canTerastallize || '';
			}
		}
	}

	/** Public foe view of the active pokemon for the AI. */
	foeView() {
		const f = this.foeActive;
		if (!f) return null;
		return {
			name: f.name,
			species: f.species,
			level: f.level,
			types: f.types,
			hpRatio: f.hpRatio,
			status: f.status,
			moves: f.moves,
			item: f.item,
			ability: f.ability,
			terastallized: f.terastallized,
		};
	}
}

module.exports = {
	BattleTracker,
	TrackedPokemon,
	parseDetails,
	parseCondition,
	parseIdent,
};
