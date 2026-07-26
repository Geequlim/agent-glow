import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { DeviceDescriptorSchema } from '../src/device.js';

describe('DeviceDescriptorSchema', () => {
	it('requires a backend-qualified ID and generic capabilities', () => {
		expect(
			Value.Check(DeviceDescriptorSchema, {
				id: 'fake:device-1',
				name: 'Fake light',
				capabilities: ['power', 'static_color', 'brightness'],
			}),
		).toBe(true);
		expect(
			Value.Check(DeviceDescriptorSchema, {
				id: '/temporary/object/path',
				name: 'Leaky device',
				capabilities: ['static_color'],
			}),
		).toBe(false);
	});
});
