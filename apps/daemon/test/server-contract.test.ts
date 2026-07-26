import { AsusdLightingBackend } from '@agent-glow/backend-asusd';
import type {
	BackendApplyResult,
	BackendSnapshot,
	LightingBackend,
	StaticVisualState,
} from '@agent-glow/core/backend';
import { FakeLightingBackend } from '@agent-glow/core/fake-backend';
import type { DeviceDescriptor } from '@agent-glow/protocol/device';
import type { DeviceConfigurationValues } from '@agent-glow/protocol/device-configuration';
import { describe, expect, it, vi } from 'vitest';

import { restoreBackendSnapshots } from '../src/server.js';

const initialAuraValue = {
	signature: '(uu(yyy)(yyy)ss)',
	value: [0, 0, [1, 2, 3], [0, 0, 0], 'Med', 'Right'],
};
const idleState: StaticVisualState = {
	color: { red: 64, green: 32, blue: 96 },
	hardwareIntensity: 0.2,
	intensity: 0.25,
	semanticState: 'idle',
};
const workingState: StaticVisualState = {
	color: { red: 88, green: 101, blue: 242 },
	hardwareIntensity: 0.7,
	intensity: 0.5,
	semanticState: 'working',
};

class AuraFixtureTransport {
	current = structuredClone(initialAuraValue);
	closed = false;

	async readManagedObjects() {
		return [
			{
				path: '/fixture/aura/1',
				interfaces: [
					{
						name: 'xyz.ljones.Aura',
						properties: { LedModeData: this.current },
					},
				],
			},
		];
	}

	async callMethod(): Promise<undefined> {
		return undefined;
	}

	async getProperty() {
		return structuredClone(this.current);
	}

	async setProperty(
		_path: string,
		_interfaceName: string,
		_propertyName: string,
		property: typeof initialAuraValue,
	): Promise<void> {
		this.current = structuredClone(property);
	}

	close(): void {
		this.closed = true;
	}
}

describe('daemon backend contract', () => {
	it('runs the common contract with fake backend', async () => {
		await runBackendContract(new FakeLightingBackend(), 'fake');
	});

	it('runs the common contract with backend-asusd fixture', async () => {
		const transport = new AuraFixtureTransport();
		const backend = new AsusdLightingBackend(transport);

		await runBackendContract(backend, 'asusd');

		expect(transport.current).toEqual(initialAuraValue);
		expect(transport.closed).toBe(true);
	});

	it('applies and logs the safe idle fallback when snapshot restoration fails', async () => {
		const backend = new RestoreFailingBackend();
		const snapshot = await backend.captureSnapshot('restore-failure:light-1');
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		try {
			await expect(restoreBackendSnapshots(backend, [snapshot])).rejects.toThrow(
				'Backend snapshot restoration failed',
			);
			expect(backend.applied.at(-1)?.semanticState).toBe('idle');
			expect(errorLog).toHaveBeenCalledWith(
				expect.stringContaining('snapshot restore failed'),
			);
			expect(warningLog).toHaveBeenCalledWith(
				expect.stringContaining('applied safe fallback'),
			);
		} finally {
			errorLog.mockRestore();
			warningLog.mockRestore();
		}
	});
});

async function runBackendContract(
	backend: LightingBackend,
	expectedBackendId: string,
): Promise<void> {
	const devices = await backend.discoverDevices();
	expect(devices).toHaveLength(1);
	const deviceId = devices[0]?.id;
	if (!deviceId) throw new Error('Contract backend did not expose a device');

	const configuration = await backend.getDeviceConfiguration(deviceId);
	expect(configuration).toMatchObject({ deviceId, settings: [], values: {} });
	const snapshot = await backend.captureSnapshot(deviceId);
	const idleResult = await backend.applyVisualState(deviceId, idleState);
	const workingResult = await backend.applyVisualState(deviceId, workingState);
	expect(idleResult.requested.semanticState).toBe('idle');
	expect(workingResult.requested.semanticState).toBe('working');
	expect(snapshot).toMatchObject({ backendId: expectedBackendId, deviceId });

	await restoreBackendSnapshots(backend, [snapshot]);
	await backend.close();
	expect(backend.getHealth()).toBe('unavailable');
}

class RestoreFailingBackend implements LightingBackend {
	readonly id = 'restore-failure';
	readonly applied: StaticVisualState[] = [];

	getHealth(): 'healthy' {
		return 'healthy';
	}

	async discoverDevices(): Promise<readonly DeviceDescriptor[]> {
		return [
			{
				id: 'restore-failure:light-1',
				name: 'Restore failure fixture',
				capabilities: ['static_color'],
			},
		];
	}

	async getDeviceConfiguration(deviceId: string) {
		return { deviceId, settings: [], values: {} };
	}

	async updateDeviceConfiguration(
		_deviceId: string,
		_values: DeviceConfigurationValues,
	): Promise<void> {}

	async captureSnapshot(deviceId: string): Promise<BackendSnapshot> {
		return { backendId: this.id, deviceId, value: null };
	}

	async applyVisualState(
		_deviceId: string,
		visualState: StaticVisualState,
	): Promise<BackendApplyResult> {
		this.applied.push(visualState);
		return { requested: visualState, applied: visualState, degraded: false };
	}

	async restoreSnapshot(): Promise<void> {
		throw new Error('fixture restore failure');
	}

	async close(): Promise<void> {}
}
