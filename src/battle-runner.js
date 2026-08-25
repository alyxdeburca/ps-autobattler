/**
 * battle-runner.js
 *
 * Runs full Pokémon Showdown battles between AIs on the headless engine.
 *
 * Usage (CLI):
 *   node src/battle-runner.js --games 20 --format gen9randombattle --p2 random
 *
 * API:
 *   const { runBattle } = require('./battle-runner');
 *   const result = await runBattle({ formatid: 'gen9randombattle' });
 *   // => { winner, turns, log, durationMs }
 */
'use strict';

const { BattleStream, getPlayerStreams } =
	require('../../pokemon-showdown/dist/sim/index');
const { HeuristicPlayerAI } = require('./heuristic-ai');
const { RandomPlayerAI } =
	require('../../pokemon-showdown/dist/sim/tools/random-player-ai');
const dex = require('./dex-shim');

function parseChunk(chunk, state) {
	for (const line of String(chunk).split('\n')) {
		if (line.startsWith('|turn|')) {
			const t = parseInt(line.slice(6), 10);
			if (Number.isFinite(t)) state.turns = Math.max(state.turns || 0, t);
		} else if (line.startsWith('|win|')) {
			state.winner = line.slice(5).trim();
		} else if (line.startsWith('|tie|')) {
			state.winner = '';
		} else if (!line.startsWith('|') && line.includes('{') && line.startsWith('end')) {
			try {
				const data = JSON.parse(line.slice(3).trim());
				if (data && data.winner !== undefined) state.endData = data;
				if (data && typeof data.turn === 'number') {
					state.turns = Math.max(state.turns || 0, data.turn);
				}
			} catch (e) { /* partial json */ }
		}
		state.log.push(line);
		if (state.onLog) state.onLog(line);
	}
}

/**
 * Run a single battle.
 *
 * @param {object} opts
 *   formatid - Showdown format id (default gen9randombattle)
 *   p2       - 'random' | 'heuristic' (opponent type)
 *   seed     - optional [a,b,c,d] PRNG seed for reproducible games
 *   debug    - echo engine protocol to stderr
 *   onLog    - callback(line) for live battle text
 */
async function runBattle(opts = {}) {
	const formatid = opts.formatid || 'gen9randombattle';
	dex.init(formatid); // ensure game data loaded before generating teams

	const debug = !!opts.debug;
	const stream = new BattleStream({ debug });
	const streams = getPlayerStreams(stream);

	const state = { winner: null, turns: 0, log: [], onLog: opts.onLog };
	let done;
	const finished = new Promise(res => { done = res; });

	void (async () => {
		for await (const chunk of streams.omniscient) {
			parseChunk(chunk, state);
		}
		done();
	})();

	const p1 = new HeuristicPlayerAI(streams.p1, {
		name: 'HeuristicBot',
		side: 'p1',
		debug,
	});
	let p2;
	if (opts.p2 === 'heuristic') {
		p2 = new HeuristicPlayerAI(streams.p2, { name: 'HeuristicBot2', side: 'p2', debug });
	} else {
		p2 = new RandomPlayerAI(streams.p2, { seed: opts.seed || undefined });
	}

	const startedAt = Date.now();

	void p1.start().catch(err => {
		state.log.push(`[runner] p1 ai error: ${err.message}`);
		done();
	});
	void p2.start().catch(err => {
		state.log.push(`[runner] p2 ai error: ${err.message}`);
		done();
	});

	const spec = { formatid };
	if (opts.seed) spec.seed = opts.seed;
	const p1spec = { name: 'HeuristicBot' }; // random format: engine generates team
	const p2spec = { name: opts.p2 === 'heuristic' ? 'HeuristicBot2' : 'RandomBot' };

	streams.omniscient.write(
		`>start ${JSON.stringify(spec)}\n` +
		`>player p1 ${JSON.stringify(p1spec)}\n` +
		`>player p2 ${JSON.stringify(p2spec)}\n`
	);

	await finished;

	return {
		winner: state.winner !== null ? state.winner : (state.endData && state.endData.winner) || '',
		winnerSide: state.winner === 'HeuristicBot' ? 'p1'
			: state.winner === 'HeuristicBot2' || state.winner === 'RandomBot' ? 'p2' : '',
		turns: state.turns,
		log: state.log,
		durationMs: Date.now() - startedAt,
	};
}

module.exports = { runBattle };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
	const args = process.argv.slice(2);
	function flag(name, fallback) {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args[i + 1] : fallback;
	}
	const has = name => args.includes(`--${name}`);

	const games = parseInt(flag('games', '1'), 10) || 1;
	const formatid = flag('format', 'gen9randombattle');
	const p2 = flag('p2', 'random');
	const verbose = has('verbose');
	const quiet = has('quiet');

	(async () => {
		let botWins = 0, oppWins = 0, ties = 0;
		let totalTurns = 0, totalMs = 0;
		for (let g = 1; g <= games; g++) {
			const res = await runBattle({
				formatid,
				p2,
				onLog: verbose ? line => console.log(line) : null,
			});
			totalTurns += res.turns;
			totalMs += res.durationMs;
			if (res.winner === 'HeuristicBot' ||
				res.winner === 'HeuristicBot' && res.winnerSide === 'p1') {
				botWins++;
				if (!quiet) console.log(`game ${g}: WIN  vs ${res.winner} (${res.turns} turns, ${res.durationMs}ms)`);
			} else if (res.winner === '' || res.winner === undefined) {
				ties++;
				if (!quiet) console.log(`game ${g}: TIE (${res.turns} turns, ${res.durationMs}ms)`);
			} else {
				oppWins++;
				if (!quiet) console.log(`game ${g}: LOSS vs ${res.winner} (${res.turns} turns, ${res.durationMs}ms)`);
			}
		}
		console.log('----------------------------------------');
		console.log(`format: ${formatid} | opponent: ${p2} | games: ${games}`);
		console.log(`bot wins: ${botWins} | opponent wins: ${oppWins} | ties: ${ties}`);
		console.log(`avg turns: ${(totalTurns / games).toFixed(1)} | avg time: ${(totalMs / games).toFixed(0)}ms`);
		process.exitCode = 0;
	})().catch(err => {
		console.error(err);
		process.exitCode = 1;
	});
}
