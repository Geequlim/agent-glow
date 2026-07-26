import type { DeviceDescriptor } from '@agent-glow/protocol/device';

import type {
	BackendApplyResult,
	BackendSnapshot,
	LightingBackend,
	StaticVisualState,
} from './backend.js';

const DEFAULT_DEVICE: DeviceDescriptor = {
	id: 'fake:light-1',
	name: 'Fake light',
	capabilities: ['power', 'static_color', 'brightness'],
};

export interface FakeBackendCommit {
	readonly deviceId: string;
	readonly visualState: StaticVisualState;
}

export class FakeLightingBackend implements LightingBackend {
	readonly id = 'fake';
	readonly commits: FakeBackendCommit[] = [];

	readonly #devices: readonly DeviceDescriptor[];
	readonly #states = new Map<string, StaticVisualState | null>();
	#closed = false;

	constructor(devices: readonly DeviceDescriptor[] = [DEFAULT_DEVICE]) {
		this.#devices = devices;
		for (const device of devices) this.#states.set(device.id, null);
	}

	getHealth(): 'healthy' | 'unavailable' {
		return this.#closed ? 'unavailable' : 'healthy';
	}

	async discoverDevices(): Promise<readonly DeviceDescriptor[]> {
		this.#assertOpen();
		return this.#devices;
	}

	async captureSnapshot(deviceId: string): Promise<BackendSnapshot> {
		this.#assertDevice(deviceId);
		return {
			backendId: this.id,
			deviceId,
			value: this.#states.get(deviceId) ?? null,
		};
	}

	async applyVisualState(
		deviceId: string,
		visualState: StaticVisualState,
	): Promise<BackendApplyResult> {
		this.#assertDevice(deviceId);
		this.#states.set(deviceId, visualState);
		this.commits.push({ deviceId, visualState });
		return {
			requested: visualState,
			applied: visualState,
			degraded: false,
		};
	}

	async restoreSnapshot(snapshot: BackendSnapshot): Promise<void> {
		this.#assertOpen();
		if (snapshot.backendId !== this.id) throw new Error('Snapshot belongs to another backend');
		this.#assertDevice(snapshot.deviceId);
		this.#states.set(snapshot.deviceId, snapshot.value as StaticVisualState | null);
	}

	async close(): Promise<void> {
		this.#closed = true;
	}

	#assertDevice(deviceId: string): void {
		this.#assertOpen();
		if (!this.#states.has(deviceId)) throw new Error(`Unknown fake device: ${deviceId}`);
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error('Fake backend is closed');
	}
}
