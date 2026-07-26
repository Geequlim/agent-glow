import { describe, expect, it } from 'vitest';

import { createLightingBackend } from '../src/backend-factory.js';

describe('createLightingBackend', () => {
	it('uses the fake backend by default', () => {
		const backend = createLightingBackend({});

		expect(backend.id).toBe('fake');
	});

	it('requires an explicit hardware unlock for asusd', () => {
		expect(() => createLightingBackend({ AGENT_GLOW_BACKEND: 'asusd' })).toThrow(
			'Set AGENT_GLOW_HARDWARE_TEST=1',
		);
	});

	it('rejects unknown backends', () => {
		expect(() => createLightingBackend({ AGENT_GLOW_BACKEND: 'unknown' })).toThrow(
			'Unknown backend: unknown',
		);
	});

	it('rejects an unknown asusd device kind', () => {
		expect(() =>
			createLightingBackend({
				AGENT_GLOW_BACKEND: 'asusd',
				AGENT_GLOW_HARDWARE_TEST: '1',
				AGENT_GLOW_ASUSD_DEVICE_KIND: 'unknown',
			}),
		).toThrow('Unknown asusd device kind: unknown');
	});
});
