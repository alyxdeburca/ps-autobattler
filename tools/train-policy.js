/**
 * tools/train-policy.js
 *
 * Behavior cloning: train a convnetjs MLP to imitate the heuristic policy's
 * choice distribution over candidates. Output: JSON weights consumable by
 * the extension (or any JS runtime) via convnetjs.Net.fromJSON.
 *
 * Usage:
 *   node tools/train-policy.js [--games 200] [--iters 8] [--out src/policy.json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const convnetjs = require('convnetjs');

const { BattleStream, getPlayerStreams } =
	require('../../pokemon-showdown/dist/sim/index');
const { HeuristicPlayerAI } = require('../src/heuristic-ai');
const { RandomPlayerAI } =
	require('../../pokemon-showdown/dist/sim/tools/random-player-ai');
const dex = require('../src/dex-shim');
const core = require('../src/decision-core');
const { encode, FEATURES } = require('../src/features');

function flag(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] || true) : fallback;
}

/** Run `games` battles while recording (features -> chosen candidate) pairs. */
async function collect(games) {
	dex.init('gen9randombattle');
	const samples = [];
	for (let g = 0; g < games; g++) {
		if (g % 25 === 0) process.stderr.write(`collect ${g}/${games}\n`);
		const stream = new BattleStream({});
		const streams = getPlayerStreams(stream);
		const done = new Promise(res => {
			void (async () => {
				for await (const chunk of streams.omniscient) {
					const s = String(chunk);
					if (s.includes('|win|') || s.includes('|tie|')) stream.destroy();
				}
				res();
			})();
		});

		const p2 = new RandomPlayerAI(streams.p2);
		void p2.start();

		const ai = new RecordingAI(streams.p1, { side: 'p1', samples });
		void ai.start().catch(() => {});
		streams.omniscient.write(
			`>start {"formatid":"gen9randombattle"}\n` +
			`>player p1 {"name":"CloneBot"}\n` +
			`>player p2 {"name":"RandomBot"}\n`);
		await done;
	}
	return samples;
}

/** HeuristicPlayerAI that records every decision it makes. */
class RecordingAI extends HeuristicPlayerAI {
	constructor(stream, options) {
		super(stream, options);
		this.samples = options.samples;
	}

	receiveRequest(request) {
		try {
			this.tracker.seeRequest(request);
			if (request.wait) return;
			if (request.teamPreview) { this.choose('default'); return; }
			if (request.forceSwitch) {
				this.choose(core.decideForceSwitch(this.tracker, request));
				return;
			}
			if (request.active) {
				const { choice, candidates, best } =
					core.decideMove(this.tracker, request);
				// One sample per candidate: label = 1 for the chosen one.
				for (const c of candidates) {
					const x = encode(this.tracker, request, c);
					this.samples.push({ x, y: c === best ? 1 : 0, kind: c.kind });
				}
				this.choose(choice);
				return;
			}
		} catch (err) {
			try { this.choose('default'); } catch (e) {}
		}
	}
}

(async () => {
	const games = parseInt(flag('games', '100'), 10);
	const iters = parseInt(flag('iters', '8'), 10);
	const outRel = flag('out', 'policy.json');
	const t0 = Date.now();

	console.error('collecting demonstrations…');
	const samples = await collect(games);
	console.error(`${samples.length} samples in ${(Date.now() - t0) / 1000 | 0}s`);

	const positives = samples.filter(s => s.y === 1).length;
	console.error(`positives: ${positives} (${(100 * positives / samples.length).toFixed(1)}%)`);

	// --- model: MLP 34 -> 48 -> 24 -> 1, sigmoid, crossentropy -------------
	const layer_defs = [
		{ type: 'input', out_sx: 1, out_sy: 1, out_depth: FEATURES },
		{ type: 'fc', num_neurons: 48, activation: 'relu' },
		{ type: 'fc', num_neurons: 24, activation: 'relu' },
		{ type: 'regression', num_neurons: 1 },
	];
	const net = new convnetjs.Net();
	net.makeLayers(layer_defs);
	const trainer = new convnetjs.Trainer(net, {
		method: 'adadelta', l2_decay: 0.001, batch_size: 32,
	});

	for (let it = 0; it < iters; it++) {
		let loss = 0, n = 0;
		// shuffle
		for (let i = samples.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[samples[i], samples[j]] = [samples[j], samples[i]];
		}
		for (const s of samples) {
			const vol = new convnetjs.Vol(s.x);
			const stats = trainer.train(vol, [s.y]);
			loss += stats.loss; n++;
		}
		console.error(`iter ${it + 1}/${iters} loss=${(loss / n).toFixed(4)}`);
	}

	// --- quick agreement check on the training distribution -----------------
	let agree = 0, checked = 0;
	const byBattle = new Map(); // not tracked; sample-level proxy below
	for (const s of samples.slice(0, 4000)) {
		const p = net.forward(new convnetjs.Vol(s.x)).w[0];
		const pred = p >= 0.5 ? 1 : 0;
		if (pred === s.y) agree++;
		checked++;
	}
	console.error(`agreement: ${(100 * agree / checked).toFixed(1)}%`);

	const dest = path.resolve(__dirname, '..', outRel);
	fs.writeFileSync(dest, JSON.stringify({
		format: 'psab-policy-v1',
		features: FEATURES,
		trainedOn: { games, samples: samples.length, at: new Date().toISOString() },
		net: net.toJSON(),
	}));
	console.log(`wrote ${dest}`);
})().catch(e => { console.error(e); process.exit(1); });
