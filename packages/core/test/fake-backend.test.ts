import { describe, expect, it } from 'vitest';

import type { StaticVisualState } from '../src/backend.js';
import { FakeLightingBackend } from '../src/fake-backend.js';

const working: StaticVisualState = {
	color: { red: 88, green: 101, blue: 242 },
	hardwareIntensity: 0.7,
	intensity: 1,
	semanticState: 'working',
};

describe('FakeLightingBackend', () => {
	it('discovers a backend-qualified fake device and records commits', async () => {
		const backend = new FakeLightingBackend();

		expect(await backend.discoverDevices()).toEqual([
			{
				id: 'fake:light-1',
				name: 'Fake light',
				capabilities: ['power', 'static_color', 'brightness'],
			},
		]);

		const result = await backend.applyVisualState('fake:light-1', working);

		expect(result).toEqual({
			requested: working,
			applied: working,
			degraded: false,
		});
		expect(backend.commits).toEqual([{ deviceId: 'fake:light-1', visualState: working }]);
	});

	it('captures and restores its in-memory state', async () => {
		const backend = new FakeLightingBackend();
		const snapshot = await backend.captureSnapshot('fake:light-1');

		await backend.applyVisualState('fake:light-1', working);
		await backend.restoreSnapshot(snapshot);

		expect(await backend.captureSnapshot('fake:light-1')).toEqual(snapshot);
	});

	it('becomes unavailable after close', async () => {
		const backend = new FakeLightingBackend();

		await backend.close();

		expect(backend.getHealth()).toBe('unavailable');
		await expect(backend.discoverDevices()).rejects.toThrow('Fake backend is closed');
	});
});
