import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { AgentGlowConfigSchema } from '../src/config.js';

const validConfig = {
	version: 1,
	daemon: { frameRate: 10, staleSessionTimeoutMs: 300_000 },
	rendering: { colorSpace: 'linear-rgb', restoreOnExit: true, transitionMs: 300 },
	profiles: {
		working: {
			startColor: '#5865F2',
			endColor: '#5865F2',
			effect: 'breathe',
			hardwareIntensity: 0.7,
			minimumIntensity: 0.08,
			maximumIntensity: 1,
			periodMs: 2200,
		},
		tool_use: {
			startColor: '#3730FF',
			endColor: '#5870FE',
			effect: 'stream',
			hardwareIntensity: 0.8,
			minimumIntensity: 0.3,
			maximumIntensity: 0.9,
			periodMs: 1000,
		},
		waiting_permission: {
			startColor: '#FF9F1C',
			endColor: '#FF9F1C',
			effect: 'breathe',
			hardwareIntensity: 1,
			minimumIntensity: 0.15,
			maximumIntensity: 1,
			periodMs: 900,
		},
		success: {
			startColor: '#35C759',
			endColor: '#35C759',
			effect: 'pulse',
			hardwareIntensity: 0.9,
			minimumIntensity: 0.15,
			maximumIntensity: 1,
			durationMs: 900,
			pulseCount: 1,
		},
		error: {
			startColor: '#FF3B30',
			endColor: '#FF3B30',
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
	devices: {
		'example:light-1': {
			'states.working.effect': 'loading',
			'states.working.brightness': 128,
		},
	},
} as const;

describe('AgentGlowConfigSchema', () => {
	it('accepts a hardware-independent v1 configuration', () => {
		expect(Value.Check(AgentGlowConfigSchema, validConfig)).toBe(true);
	});

	it('rejects unknown fields, invalid ranges, colors and device IDs', () => {
		expect(
			Value.Check(AgentGlowConfigSchema, {
				...validConfig,
				rendering: { ...validConfig.rendering, typo: true },
			}),
		).toBe(false);
		expect(
			Value.Check(AgentGlowConfigSchema, {
				...validConfig,
				daemon: { ...validConfig.daemon, frameRate: 21 },
			}),
		).toBe(false);
		expect(
			Value.Check(AgentGlowConfigSchema, {
				...validConfig,
				profiles: {
					...validConfig.profiles,
					working: { ...validConfig.profiles.working, startColor: 'purple' },
				},
			}),
		).toBe(false);
		expect(
			Value.Check(AgentGlowConfigSchema, {
				...validConfig,
				profiles: {
					...validConfig.profiles,
					idle: {
						color: '#402060',
						effect: 'static',
						hardwareIntensity: 0.2,
						intensity: 0.25,
					},
				},
			}),
		).toBe(false);
		expect(
			Value.Check(AgentGlowConfigSchema, {
				...validConfig,
				devices: { 'invalid device': {} },
			}),
		).toBe(false);
	});

	it('rejects unknown schema versions', () => {
		expect(Value.Check(AgentGlowConfigSchema, { ...validConfig, version: 2 })).toBe(false);
	});
});
