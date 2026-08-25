/**
 * tools/eval-policy.js
 *
 * Plays N battles: NeuralPolicyAI (trained convnetjs weights) vs Random.
 * Reports win rate so we can compare against the heuristic's 69% baseline.
 *
 * Usage: node tools/eval-policy.js [policy.json] [--games 50]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const convnetjs = require('convnetjs');

const { BattleStream, getPlayerStreams } =
	require('../../pokemon-showdown/dist/sim/index');
const { RandomPlayerAI } =
	require('../../pokemon-showdown/dist/sim/tools/random-player-ai');
const dex = require('../src/dex-shim');
const core = require('../src/decision-core');
const trackerMod = require('../src/battle-state');
const { encode, FEATURES } = require('../src/features');

function flag(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

class NeuralPolicyAI {
	constructor(stream, options) {
		this.stream = stream;
		this.net = options.net;
		this.tracker = new trackerMod.BattleTracker(options.side || 'p1');
	}

	receiveLine(line) {
		if (!line.startsWith('|request|')) this.tracker.seeLine(line);
	}

	async start() {
		for await (const chunk of this.stream) {
			for (const line of String(chunk).split('\n')) {
				if (line.startsWith('|request|')) {
					this.receiveRequest(JSON.parse(line.slice(9)));
				} else {
					this.receiveLine(line);
				}
			}
		}
	}

	choose(choice) {
		void this.stream.write(choice);
	}

	receiveRequest(request) {
		try {
			this.tracker.seeRequest(request);
			trackerMod // noop reference to keep import shape stable
			;
			if (request.wait) return;
			if (request.teamPreview) { this.choose('default'); return; }
			if (request.forceSwitch) {
				this.choose(core.decideForceSwitch(this.tracker, request));
				return;
			}
			if (request.active) {
				const adapted = {
					wait: undefined,
					active: request.active,
					side: request.side,
				};
				const out = core.decideMove(this.tracker, adapted);
				// Score every candidate through the net; pick argmax.
				let bestC = null, bestP = -Infinity;
				for (const c of out.candidates) {
					const x = encode(this.tracker, adapted, c);
					const p = this.net.forward(new convnetjs.Vol(x)).w[0];
					if (p > bestP) { bestP = p; bestC = c; }
				}
				if (!bestC) { this.choose(out.choice); return; }
				let choice;
				if (bestC.kind === 'switch') choice = `switch ${bestC.slot}`;
				else if (bestC.kind === 'tera-move') choice = `move ${bestC.slot} terastallize`;
				else choice = `move ${bestC.slot}`;
				this.choose(choice);
				return;
			}
		} catch (e) {
			try { this.choose('default'); } catch (e2) {}
		}
	}
}

(async () => {
	const games = parseInt(flag('games', '50'), 10);
	const policyFile = path.resolve(__dirname, '..',
		process.argv[2] && !process.argv[2].startsWith('--')
			? process.argv[2] : 'policy.json');

	dex.init('gen9randombattle');
	const data = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
	const net = new convnetjs.Net();
	net.fromJSON(data.net);

	let wins = 0, losses = 0, ties = 0;
	for (let g = 0; g < games; g++) {
		const stream = new BattleStream({});
		const streams = getPlayerStreams(stream);
		const done = new Promise(res => {
			void (async () => {
				let winner = null;
				try {
					for await (const chunk of streams.omniscient) {
						const s = String(chunk);
						const m = s.match(/\|(?:win\||tie)([^\n]*)/);
						if (s.includes('|win|')) { winner = s.match(/\|win\|([^\n]*)/)[1]; break; }
						if (s.includes('|tie|')) { winner = ''; break; }
					}
				} catch (e) {}
				res(winner);
			})();
		});

		const p2 = new RandomPlayerAI(streams.p2);
		void p2.start();

		const ai = new NeuralPolicyAI(streams.p1, { net, side: 'p1' });
		void ai.start().catch(() => {});

		streams.omniscient.write(
			`>start {"formatid":"gen9randombattle"}\n` +
			`>player p1 {"name":"NeuralBot"}\n` +
			`>player p2 {"name":"RandomBot"}\n`);
		const w = await done;
		w === 'NeuralBot' ? wins++ : w === '' ? ties++ : losses++;
	}
	console.log(`neural vs random: ${wins}W-${losses}L-${ties}T over ${games}` +
		` (${(100 * wins / games).toFixed(0)}%)  [policy: ${path.basename(policyFile)}]`);
})().catch(e => { console.error(e); process.exit(1); });
