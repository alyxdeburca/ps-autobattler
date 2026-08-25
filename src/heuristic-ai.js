/**
 * heuristic-ai.js
 *
 * BattlePlayer adapter around the transport-free decision-core.
 * Responsibilities here are only:
 *   - feed every visible protocol line + requests into the BattleTracker
 *   - call decision-core for each request and send the chosen string
 *
 * The pure brain lives in decision-core.js so the Chrome extension can reuse
 * it verbatim against Showdown's own client-side battle state.
 */
'use strict';

const { BattlePlayer } = require('../../pokemon-showdown/dist/sim/battle-stream');
const trackerMod = require('./battle-state');
const core = require('./decision-core');

const { BattleTracker } = trackerMod;

class HeuristicPlayerAI extends BattlePlayer {
	constructor(playerStream, options = {}) {
		super(playerStream, options.debug);
		this.name = options.name || 'HeuristicBot';
		this.tracker = new BattleTracker(options.side || 'p1');

		this.stats = {
			requests: 0,
			movesChosen: 0,
			switchesChosen: 0,
			errors: [],
		};
	}

	receiveLine(line) {
		// Requests go through the normal path (they trigger receiveRequest).
		// Every OTHER line on our stream (public updates + our sideupdate)
		// feeds the tracker -- this is how we learn about the foe's team.
		super.receiveLine(line);
		if (!line.startsWith('|request|')) {
			try {
				this.tracker.seeLine(line);
			} catch (e) {
				this.stats.errors.push(`track: ${e && e.message}`);
			}
		}
	}

	receiveError(error) {
		// Unavailable choices get retried with fresh state; anything else bubbles.
		if (error.message.startsWith('[Unavailable choice]')) return;
		this.stats.errors.push(error.message);
		throw error;
	}

	receiveRequest(request) {
		try {
			this.tracker.seeRequest(request);
			this.stats.requests++;

			if (request.wait) return;

			if (request.teamPreview) {
				this.choose(this.chooseTeamPreview(request));
				return;
			}

			if (request.forceSwitch) {
				const choice = core.decideForceSwitch(this.tracker, request);
				if (choice.includes('switch')) this.stats.switchesChosen++;
				this.choose(choice);
				return;
			}

			if (request.active) {
				const { choice } = core.decideMove(this.tracker, request);
				if (choice.startsWith('switch')) this.stats.switchesChosen++;
				else this.stats.movesChosen++;
				this.choose(choice);
				return;
			}
		} catch (err) {
			// Never let an AI bug hang the battle: fall back to a safe default.
			this.stats.errors.push(`fallback: ${err && err.message}`);
			try {
				this.choose('default');
			} catch (e) { /* stream already closed */ }
		}
	}

	chooseTeamPreview(request) {
		return 'default';
	}
}

module.exports = { HeuristicPlayerAI };
