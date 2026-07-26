import { describe, expect, it } from 'vitest';

import { createLightingBackend } from '../src/backend-factory.js';

describe('createLightingBackend', () => {
	it('uses the fake backend by default', () => {
		const backend = createLightingBackend({});

		expect(backend.id).toBe('fake');
	});

	it('creates the production asusd backend when selected by the service', async () => {
		const backend = createLightingBackend({ AGENT_GLOW_BACKEND: 'asusd' });

		expect(backend.id).toBe('asusd');
		await backend.close();
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
				AGENT_GLOW_ASUSD_DEVICE_KIND: 'unknown',
			}),
		).toThrow('Unknown asusd device kind: unknown');
	});
});
