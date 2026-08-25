/**
 * dex-shim.js
 *
 * Bridges the auto-battler to Pokémon Showdown's compiled Dex (game data):
 * species stats/types, move data, items, abilities, type chart.
 *
 * We deliberately go through `dist/` (the compiled JS) so this package runs
 * without a TypeScript toolchain -- which also makes bundling into a Chrome
 * extension straightforward later.
 */
'use strict';

let moddedDex = null;

/** Resolve a Dex-like backend for the current environment.
 *  - Node: load the sibling compiled simulator.
 *  - Browser/extension content script: use `window.__PS_DEX_BACKEND__`,
 *    injected by the extension bridge from the live Showdown client's own
 *    Dex -- no bundled engine needed on the page.
 */
function resolveBackend(formatid) {
	const isNode = typeof process !== 'undefined' &&
		!!process.versions && !!process.versions.node;
	if (isNode) {
		return require('../../pokemon-showdown/dist/sim/index').Dex.forFormat(formatid);
	}
	const injected = (typeof window !== 'undefined') && window.__PS_DEX_BACKEND__;
	if (!injected) {
		throw new Error('No Dex backend: expected window.__PS_DEX_BACKEND__ ' +
			'(injected by the extension bridge from the Showdown client)');
	}
	return injected;
}

/** Initialize (once) a format-aware Dex. Safe to call repeatedly. */
function init(formatid = 'gen9randombattle') {
	if (moddedDex) return moddedDex;
	moddedDex = resolveBackend(formatid);
	try {
		if (typeof moddedDex.includeModData === 'function') moddedDex.includeModData();
	} catch (e) {
		// Non-critical: base data still works for most formats.
	}
	return moddedDex;
}

function exists(entry) {
	return entry && entry.exists !== false && entry.id;
}

function speciesFromId(idOrName) {
	const sp = init().species.get(String(idOrName || ''));
	return exists(sp) ? sp : null;
}

function moveFromId(idOrName) {
	const mv = init().moves.get(String(idOrName || ''));
	return exists(mv) ? mv : null;
}

function itemFromId(idOrName) {
	const it = init().items.get(String(idOrName || ''));
	return exists(it) ? it : null;
}

function abilityFromId(idOrName) {
	const ab = init().abilities.get(String(idOrName || ''));
	return exists(ab) ? ab : null;
}

/** Summed type effectiveness of moveType against a list of defending types.
 *  >0 super effective, 0 neutral, <0 resisted. */
function getEffectiveness(moveType, defTypes) {
	const dex = init();
	let mod = 0;
	for (const t of defTypes) mod += dex.getEffectiveness(moveType, t);
	return mod;
}

/** True if any defending type grants immunity to moveType. */
function isImmune(moveType, defTypes) {
	const dex = init();
	for (const t of defTypes) {
		if (!dex.getImmunity(moveType, t)) return true;
	}
	return false;
}

module.exports = {
	init,
	speciesFromId,
	moveFromId,
	itemFromId,
	abilityFromId,
	getEffectiveness,
	isImmune,
};
