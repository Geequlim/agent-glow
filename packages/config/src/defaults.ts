import type { AgentGlowConfig } from '@agent-glow/protocol/config';

export const DEFAULT_AGENT_GLOW_CONFIG = {
	version: 1,
	daemon: {
		frameRate: 15,
		retainedStateTimeoutMs: 10 * 60 * 1000,
		staleSessionTimeoutMs: 300_000,
	},
	rendering: {
		colorSpace: 'linear-rgb',
		restoreOnExit: true,
		transitionMs: 300,
	},
	profiles: {
		working: {
			startColor: '#5865F2',
			endColor: '#5865F2',
			effect: 'breathe',
			hardwareIntensity: 0.65,
			minimumVisibleMs: 500,
			minimumIntensity: 0.22,
			maximumIntensity: 0.72,
			periodMs: 2800,
		},
		tool_use: {
			startColor: '#00B8D9',
			endColor: '#5865F2',
			effect: 'stream',
			hardwareIntensity: 0.8,
			minimumVisibleMs: 800,
			minimumIntensity: 0.3,
			maximumIntensity: 0.9,
			periodMs: 1000,
		},
		waiting_permission: {
			startColor: '#FF9F1C',
			endColor: '#FF9F1C',
			effect: 'breathe',
			hardwareIntensity: 0.85,
			minimumVisibleMs: 600,
			minimumIntensity: 0.2,
			maximumIntensity: 0.9,
			periodMs: 1000,
		},
		success: {
			startColor: '#5865F2',
			endColor: '#35C759',
			effect: 'pulse',
			hardwareIntensity: 0.65,
			minimumVisibleMs: 1800,
			minimumIntensity: 0.18,
			maximumIntensity: 0.85,
			durationMs: 1800,
			pulseCount: 2,
		},
		error: {
			startColor: '#FF3B30',
			endColor: '#FF3B30',
			effect: 'pulse',
			hardwareIntensity: 0.9,
			minimumVisibleMs: 1200,
			minimumIntensity: 0.15,
			maximumIntensity: 1,
			durationMs: 1200,
			pulseCount: 2,
		},
		paused: {
			color: '#FFF4D6',
			effect: 'static',
			hardwareIntensity: 0.18,
			intensity: 0.18,
			minimumVisibleMs: 500,
		},
	},
	devices: {},
} as const satisfies AgentGlowConfig;

export function createDefaultConfig(): AgentGlowConfig {
	return structuredClone(DEFAULT_AGENT_GLOW_CONFIG);
}
