import type { SemanticState } from '@agent-glow/protocol/semantic-state';

import type { MonotonicClock } from './lease-arbiter.js';

export type MinimumVisibleDuration = (state: Exclude<SemanticState, 'idle'>) => number;

export class PresentationStateGuard {
	readonly #clock: MonotonicClock;
	readonly #minimumVisibleDuration: MinimumVisibleDuration;
	#presentedState: SemanticState = 'idle';
	#protectedUntil = 0;

	constructor(
		minimumVisibleDuration: MinimumVisibleDuration,
		clock: MonotonicClock = { now: () => performance.now() },
	) {
		this.#clock = clock;
		this.#minimumVisibleDuration = minimumVisibleDuration;
	}

	select(desiredState: SemanticState): SemanticState {
		const now = this.#clock.now();
		if (
			desiredState !== this.#presentedState &&
			this.#presentedState !== 'idle' &&
			now < this.#protectedUntil
		) {
			return this.#presentedState;
		}
		if (desiredState !== this.#presentedState) {
			this.#presentedState = desiredState;
			this.#protectedUntil =
				desiredState === 'idle' ? now : now + this.#minimumVisibleDuration(desiredState);
		}
		return desiredState;
	}
}
