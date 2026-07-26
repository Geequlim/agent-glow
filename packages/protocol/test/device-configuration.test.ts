import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { DeviceConfigurationSchema } from '../src/device-configuration.js';

describe('DeviceConfigurationSchema', () => {
	it('accepts backend-registered typed settings', () => {
		expect(
			Value.Check(DeviceConfigurationSchema, {
				deviceId: 'future-rgb:light-1',
				settings: [
					{
						key: 'states.working.brightness',
						label: 'Brightness',
						group: 'working',
						kind: 'integer',
						defaultValue: 128,
						minimum: 0,
						maximum: 255,
						step: 1,
					},
				],
				values: { 'states.working.brightness': 128 },
			}),
		).toBe(true);
	});

	it('rejects unsafe setting keys and non-primitive values', () => {
		expect(
			Value.Check(DeviceConfigurationSchema, {
				deviceId: 'future-rgb:light-1',
				settings: [],
				values: { '../outside': { nested: true } },
			}),
		).toBe(false);
	});
});
