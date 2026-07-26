import { describe, expect, it } from 'vitest';

import type { DeviceConfiguration } from '@agent-glow/protocol/device-configuration';

import { mergeDeviceConfiguration } from '../src/device-configuration.js';

const configuration: DeviceConfiguration = {
	deviceId: 'future-rgb:light-1',
	settings: [
		{
			key: 'states.working.brightness',
			label: 'Brightness',
			kind: 'integer',
			defaultValue: 128,
			minimum: 0,
			maximum: 255,
			step: 1,
		},
		{
			key: 'states.working.effect',
			label: 'Animation',
			kind: 'select',
			defaultValue: 'loading',
			options: [
				{ value: 'loading', label: 'Loading' },
				{ value: 'spectrum', label: 'Spectrum' },
			],
		},
	],
	values: {
		'states.working.brightness': 128,
		'states.working.effect': 'loading',
	},
};

describe('mergeDeviceConfiguration', () => {
	it('merges a valid partial update', () => {
		expect(
			mergeDeviceConfiguration(configuration, {
				'states.working.brightness': 200,
			}).values,
		).toEqual({
			'states.working.brightness': 200,
			'states.working.effect': 'loading',
		});
	});

	it('rejects unknown, out-of-range, and unavailable values', () => {
		expect(() => mergeDeviceConfiguration(configuration, { unknown: true })).toThrow(
			'Unknown device configuration setting',
		);
		expect(() =>
			mergeDeviceConfiguration(configuration, {
				'states.working.brightness': 256,
			}),
		).toThrow('Invalid value');
		expect(() =>
			mergeDeviceConfiguration(configuration, {
				'states.working.effect': 'missing',
			}),
		).toThrow('Invalid value');
	});
});
