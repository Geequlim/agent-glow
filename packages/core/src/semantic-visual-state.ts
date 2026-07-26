import type { SemanticState } from '@agent-glow/protocol/semantic-state';

import type { RgbColor, StaticVisualState } from './backend.js';

export interface StaticVisualEffect {
	readonly color: RgbColor;
	readonly effect: 'static';
	readonly hardwareIntensity: number;
	readonly intensity: number;
	readonly semanticState: SemanticState;
}

export interface BreatheVisualEffect {
	readonly color: RgbColor;
	readonly effect: 'breathe';
	readonly hardwareIntensity: number;
	readonly maximumIntensity: number;
	readonly minimumIntensity: number;
	readonly periodMs: number;
	readonly semanticState: SemanticState;
}

export type SemanticVisualEffect = StaticVisualEffect | BreatheVisualEffect;

const visualEffects: Readonly<Record<SemanticState, SemanticVisualEffect>> = {
	idle: {
		effect: 'static',
		color: { red: 64, green: 32, blue: 96 },
		hardwareIntensity: 0.2,
		intensity: 0.25,
		semanticState: 'idle',
	},
	paused: {
		effect: 'static',
		color: { red: 255, green: 244, blue: 214 },
		hardwareIntensity: 0.3,
		intensity: 0.25,
		semanticState: 'paused',
	},
	working: {
		effect: 'breathe',
		color: { red: 88, green: 101, blue: 242 },
		hardwareIntensity: 0.7,
		minimumIntensity: 0.08,
		maximumIntensity: 1,
		periodMs: 2200,
		semanticState: 'working',
	},
	success: {
		effect: 'static',
		color: { red: 53, green: 199, blue: 89 },
		hardwareIntensity: 0.9,
		intensity: 1,
		semanticState: 'success',
	},
	waiting_permission: {
		effect: 'breathe',
		color: { red: 255, green: 159, blue: 28 },
		hardwareIntensity: 1,
		minimumIntensity: 0.15,
		maximumIntensity: 1,
		periodMs: 900,
		semanticState: 'waiting_permission',
	},
	error: {
		effect: 'static',
		color: { red: 255, green: 59, blue: 48 },
		hardwareIntensity: 1,
		intensity: 1,
		semanticState: 'error',
	},
};

export function getSemanticVisualEffect(state: SemanticState): SemanticVisualEffect {
	return visualEffects[state];
}

export function renderVisualFrame(
	effect: SemanticVisualEffect,
	elapsedMilliseconds: number,
): StaticVisualState {
	if (effect.effect === 'static') {
		return {
			color: effect.color,
			hardwareIntensity: effect.hardwareIntensity,
			intensity: effect.intensity,
			semanticState: effect.semanticState,
		};
	}

	const phase = (Math.max(0, elapsedMilliseconds) % effect.periodMs) / effect.periodMs;
	const progress = (1 - Math.cos(phase * Math.PI * 2)) / 2;
	return {
		color: effect.color,
		hardwareIntensity: effect.hardwareIntensity,
		intensity:
			effect.minimumIntensity +
			(effect.maximumIntensity - effect.minimumIntensity) * progress,
		semanticState: effect.semanticState,
	};
}
