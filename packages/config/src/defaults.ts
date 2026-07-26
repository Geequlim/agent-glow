import type { AgentGlowConfig } from '@agent-glow/protocol/config';

export const DEFAULT_AGENT_GLOW_CONFIG = {
	version: 1,
	daemon: {
		frameRate: 10,
		staleSessionTimeoutMs: 300_000,
	},
	rendering: {
		colorSpace: 'linear-rgb',
		restoreOnExit: true,
		transitionMs: 300,
	},
	profiles: {
		working: {
			color: '#5865F2',
			effect: 'breathe',
			hardwareIntensity: 0.7,
			minimumIntensity: 0.08,
			maximumIntensity: 1,
			periodMs: 2200,
		},
		waiting_permission: {
			color: '#FF9F1C',
			effect: 'breathe',
			hardwareIntensity: 1,
			minimumIntensity: 0.15,
			maximumIntensity: 1,
			periodMs: 900,
		},
		success: {
			color: '#35C759',
			effect: 'pulse',
			hardwareIntensity: 0.9,
			minimumIntensity: 0.15,
			maximumIntensity: 1,
			durationMs: 900,
			pulseCount: 1,
		},
		error: {
			color: '#FF3B30',
			effect: 'pulse',
			hardwareIntensity: 1,
			minimumIntensity: 0.15,
			maximumIntensity: 1,
			durationMs: 1000,
			pulseCount: 2,
		},
		paused: {
			color: '#FFF4D6',
			effect: 'static',
			hardwareIntensity: 0.3,
			intensity: 0.25,
		},
	},
	devices: {},
} as const satisfies AgentGlowConfig;

export function createDefaultConfig(): AgentGlowConfig {
	return structuredClone(DEFAULT_AGENT_GLOW_CONFIG);
}
