import type { MonotonicClock } from './lease-arbiter.js';
import { easeInOutCubic, interpolateColorLinear } from './color-space.js';
import type { StaticVisualState } from './backend.js';
import { renderVisualFrame, type SemanticVisualEffect } from './semantic-visual-state.js';

export const DEFAULT_TRANSITION_DURATION_MS = 300;

interface Transition {
	readonly from: StaticVisualState;
	readonly startedAt: number;
}

export class VisualStateEngine {
	readonly #clock: MonotonicClock;
	readonly #transitionDurationMs: number;
	#effect: SemanticVisualEffect;
	#effectStartedAt: number;
	#transition: Transition | undefined;

	constructor(
		initialEffect: SemanticVisualEffect,
		clock: MonotonicClock = { now: () => performance.now() },
		transitionDurationMs = DEFAULT_TRANSITION_DURATION_MS,
	) {
		this.#clock = clock;
		this.#transitionDurationMs = transitionDurationMs;
		this.#effect = initialEffect;
		this.#effectStartedAt = clock.now();
	}

	setTarget(effect: SemanticVisualEffect, restart = false): void {
		if (!restart && effect.semanticState === this.#effect.semanticState) return;
		const now = this.#clock.now();
		const from = this.frame(now);
		this.#effect = effect;
		this.#effectStartedAt = now;
		this.#transition = this.#transitionDurationMs === 0 ? undefined : { from, startedAt: now };
	}

	frame(now = this.#clock.now()): StaticVisualState {
		const target = renderVisualFrame(this.#effect, now - this.#effectStartedAt);
		if (!this.#transition) return target;

		const progress = (now - this.#transition.startedAt) / this.#transitionDurationMs;
		if (progress >= 1) {
			this.#transition = undefined;
			return target;
		}
		const eased = easeInOutCubic(progress);
		return {
			color: interpolateColorLinear(this.#transition.from.color, target.color, eased),
			hardwareIntensity: interpolate(
				this.#transition.from.hardwareIntensity,
				target.hardwareIntensity,
				eased,
			),
			intensity: interpolate(this.#transition.from.intensity, target.intensity, eased),
			semanticState: target.semanticState,
		};
	}

	isAnimating(now = this.#clock.now()): boolean {
		if (this.#transition) return true;
		if (this.#effect.effect === 'breathe') return true;
		return (
			this.#effect.effect === 'pulse' && now - this.#effectStartedAt < this.#effect.durationMs
		);
	}
}

function interpolate(from: number, to: number, progress: number): number {
	return from + (to - from) * progress;
}
