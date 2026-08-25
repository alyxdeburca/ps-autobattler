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
let explicitBackend = null;

/** Register a Dex-like backend explicitly (used by the Chrome extension,
 *  which bundles its own MiniDex). Takes precedence over auto-resolution. */
function setBackend(backend) {
	explicitBackend = backend;
	moddedDex = null; // allow rebinding
}

/** Resolve a Dex-like backend for the current environment.
 *  1. explicit setBackend() registration
 *  - Node: load the sibling compiled simulator (via hidden require so
 *    bundlers like esbuild don't try to follow it).
 *  - Browser fallback: `window.__PS_DEX_BACKEND__`.
 */
function resolveBackend(formatid) {
	if (explicitBackend) return explicitBackend;
	const isNode = typeof process !== 'undefined' &&
		!!process.versions && !!process.versions.node;
	if (isNode) {
		// eslint-disable-next-line no-eval -- hide from static bundlers
		const req = eval('require');
		return req('../../pokemon-showdown/dist/sim/index').Dex.forFormat(formatid);
	}
	const injected = (typeof window !== 'undefined') && window.__PS_DEX_BACKEND__;
	if (!injected) {
		throw new Error('No Dex backend: call setBackend() or set window.__PS_DEX_BACKEND__');
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

/** Full possible movepool of a species in random battles (exact global
 *  sets -- not a guess). Returns [] when unknown / non-random formats. */
function randomMovesFor(idOrName) {
	const data = init().data;
	const id = String(idOrName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	if (data && data.randomMoves && data.randomMoves[id]) {
		return data.randomMoves[id];
	}
	return [];
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
	setBackend,
	speciesFromId,
	moveFromId,
	itemFromId,
	abilityFromId,
	randomMovesFor,
	getEffectiveness,
	isImmune,
};
