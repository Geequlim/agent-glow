import type { SemanticState } from '@agent-glow/protocol/semantic-state';

import type { RgbColor, StaticVisualState } from './backend.js';
import { interpolateColorLinear } from './color-space.js';

export interface StaticVisualEffect {
	readonly color: RgbColor;
	readonly effect: 'static';
	readonly hardwareIntensity: number;
	readonly intensity: number;
	readonly semanticState: SemanticState;
}

export interface BreatheVisualEffect {
	readonly startColor: RgbColor;
	readonly endColor: RgbColor;
	readonly effect: 'breathe';
	readonly hardwareIntensity: number;
	readonly maximumIntensity: number;
	readonly minimumIntensity: number;
	readonly periodMs: number;
	readonly semanticState: SemanticState;
}

export interface StreamVisualEffect {
	readonly startColor: RgbColor;
	readonly endColor: RgbColor;
	readonly effect: 'stream';
	readonly hardwareIntensity: number;
	readonly maximumIntensity: number;
	readonly minimumIntensity: number;
	readonly periodMs: number;
	readonly semanticState: SemanticState;
}

export interface PulseVisualEffect {
	readonly startColor: RgbColor;
	readonly endColor: RgbColor;
	readonly durationMs: number;
	readonly effect: 'pulse';
	readonly hardwareIntensity: number;
	readonly maximumIntensity: number;
	readonly minimumIntensity: number;
	readonly pulseCount: number;
	readonly semanticState: SemanticState;
}

export type SemanticVisualEffect =
	| StaticVisualEffect
	| BreatheVisualEffect
	| StreamVisualEffect
	| PulseVisualEffect;

const visualEffects: Readonly<Record<SemanticState, SemanticVisualEffect>> = {
	idle: {
		effect: 'static',
		color: { red: 0, green: 0, blue: 0 },
		hardwareIntensity: 0,
		intensity: 0,
		semanticState: 'idle',
	},
	paused: {
		effect: 'static',
		color: { red: 255, green: 244, blue: 214 },
		hardwareIntensity: 0.18,
		intensity: 0.18,
		semanticState: 'paused',
	},
	working: {
		effect: 'breathe',
		startColor: { red: 88, green: 101, blue: 242 },
		endColor: { red: 88, green: 101, blue: 242 },
		hardwareIntensity: 0.65,
		minimumIntensity: 0.22,
		maximumIntensity: 0.72,
		periodMs: 2800,
		semanticState: 'working',
	},
	tool_use: {
		effect: 'stream',
		startColor: { red: 0, green: 184, blue: 217 },
		endColor: { red: 88, green: 101, blue: 242 },
		hardwareIntensity: 0.8,
		minimumIntensity: 0.3,
		maximumIntensity: 0.9,
		periodMs: 1000,
		semanticState: 'tool_use',
	},
	success: {
		effect: 'pulse',
		startColor: { red: 88, green: 101, blue: 242 },
		endColor: { red: 53, green: 199, blue: 89 },
		durationMs: 1800,
		hardwareIntensity: 0.65,
		minimumIntensity: 0.18,
		maximumIntensity: 0.85,
		pulseCount: 2,
		semanticState: 'success',
	},
	waiting_permission: {
		effect: 'breathe',
		startColor: { red: 255, green: 159, blue: 28 },
		endColor: { red: 255, green: 159, blue: 28 },
		hardwareIntensity: 0.85,
		minimumIntensity: 0.2,
		maximumIntensity: 0.9,
		periodMs: 1000,
		semanticState: 'waiting_permission',
	},
	error: {
		effect: 'pulse',
		startColor: { red: 255, green: 59, blue: 48 },
		endColor: { red: 255, green: 59, blue: 48 },
		durationMs: 1200,
		hardwareIntensity: 0.9,
		minimumIntensity: 0.15,
		maximumIntensity: 1,
		pulseCount: 2,
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

	const elapsed = Math.max(0, elapsedMilliseconds);
	const progress =
		effect.effect === 'breathe'
			? (1 - Math.cos(((elapsed % effect.periodMs) / effect.periodMs) * Math.PI * 2)) / 2
			: effect.effect === 'stream'
				? streamProgress((elapsed % effect.periodMs) / effect.periodMs)
				: Math.sin(
						Math.min(1, elapsed / effect.durationMs) * Math.PI * effect.pulseCount,
					) ** 2;
	return {
		color: interpolateColorLinear(effect.startColor, effect.endColor, progress),
		hardwareIntensity: effect.hardwareIntensity,
		intensity:
			effect.minimumIntensity +
			(effect.maximumIntensity - effect.minimumIntensity) * progress,
		semanticState: effect.semanticState,
	};
}

function streamProgress(phase: number): number {
	if (phase < 0.65) return 1 - phase / 0.65;
	if (phase < 0.82) return 0;
	const rise = (phase - 0.82) / 0.18;
	return rise * rise;
}
