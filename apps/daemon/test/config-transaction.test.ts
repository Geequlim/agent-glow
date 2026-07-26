import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createDefaultConfig, loadConfigFile, type PreparedConfigWrite } from '@agent-glow/config';
import type {
	BackendApplyResult,
	BackendSnapshot,
	LightingBackend,
	StaticVisualState,
} from '@agent-glow/core/backend';
import type { AgentGlowConfig } from '@agent-glow/protocol/config';
import type { DeviceDescriptor } from '@agent-glow/protocol/device';
import type {
	DeviceConfiguration,
	DeviceConfigurationValues,
} from '@agent-glow/protocol/device-configuration';
import { afterEach, describe, expect, it } from 'vitest';

import { createFileConfigRepository, type DaemonConfigRepository } from '../src/config.js';
import { startDaemonServer } from '../src/server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe('daemon configuration transactions', () => {
	it('persists a file-backed update across daemon restarts in a temporary XDG tree', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'agent-glow-file-config-'));
		temporaryDirectories.push(directory);
		const configPath = path.join(directory, 'agent-glow', 'config.yaml');
		const socketPath = path.join(directory, 'runtime', 'daemon.sock');
		const repository = createFileConfigRepository(configPath);
		const candidate = createDefaultConfig();
		candidate.rendering.transitionMs = 725;

		const first = await startDaemonServer(
			'test',
			socketPath,
			new ConfigurableBackend(['configurable:light-1']),
			{ configRepository: repository },
		);
		await request(first.socketPath, 'config.update', { config: candidate });
		await first.close();

		expect(await loadConfigFile(configPath)).toEqual(candidate);
		const restarted = await startDaemonServer(
			'test',
			socketPath,
			new ConfigurableBackend(['configurable:light-1']),
			{ configRepository: repository },
		);
		expect(await request(restarted.socketPath, 'config.get', {})).toEqual(candidate);
		await restarted.close();
	});

	it('persists device values and smoothly applies a profile across daemon restarts', async () => {
		const repository = new MemoryConfigRepository();
		const backend = new ConfigurableBackend(['configurable:light-1']);
		const first = await startTestDaemon(repository, backend);
		await emitWorking(first.socketPath);
		const before = backend.visualCommits.at(-1);
		if (!before) throw new Error('Initial visual frame missing');
		const candidate = createDefaultConfig();
		candidate.devices['configurable:light-1'] = { brightness: 42 };
		candidate.rendering.transitionMs = 200;
		candidate.profiles.working = {
			color: '#FF0000',
			effect: 'static',
			hardwareIntensity: 0.8,
			intensity: 0.6,
		};

		expect(await request(first.socketPath, 'config.validate', { config: candidate })).toEqual({
			valid: true,
		});
		expect(repository.config).toEqual(createDefaultConfig());
		expect(backend.values('configurable:light-1')).toEqual({ brightness: 10 });

		const updated = await request(first.socketPath, 'config.update', { config: candidate });
		const firstUpdatedFrame = backend.visualCommits.at(-1);
		if (!firstUpdatedFrame) throw new Error('Updated visual frame missing');

		expect(updated).toEqual(candidate);
		expect(repository.config).toEqual(candidate);
		expect(backend.values('configurable:light-1')).toEqual({ brightness: 42 });
		expect(firstUpdatedFrame.color.red).toBeCloseTo(before.color.red);
		expect(firstUpdatedFrame.color.green).toBeCloseTo(before.color.green);
		expect(firstUpdatedFrame.color.blue).toBeCloseTo(before.color.blue);

		await delay(350);
		expect(backend.visualCommits.at(-1)?.color).toEqual({ red: 255, green: 0, blue: 0 });
		await first.close();

		const restartedBackend = new ConfigurableBackend(['configurable:light-1']);
		const restarted = await startTestDaemon(repository, restartedBackend);
		await emitWorking(restarted.socketPath);

		expect(restartedBackend.values('configurable:light-1')).toEqual({ brightness: 42 });
		expect(restartedBackend.visualCommits.at(-1)?.color).toEqual({
			red: 255,
			green: 0,
			blue: 0,
		});
		expect(await request(restarted.socketPath, 'config.get', {})).toEqual(candidate);
		await restarted.close();
	});

	it('persists device.config.update through the same configuration transaction', async () => {
		const repository = new MemoryConfigRepository();
		const backend = new ConfigurableBackend(['configurable:light-1']);
		const daemon = await startTestDaemon(repository, backend);

		const result = await request(daemon.socketPath, 'device.config.update', {
			deviceId: 'configurable:light-1',
			values: { brightness: 64 },
		});

		expect(result).toMatchObject({
			deviceId: 'configurable:light-1',
			values: { enabled: true, brightness: 64 },
		});
		expect(repository.config.devices['configurable:light-1']).toEqual({
			enabled: true,
			brightness: 64,
		});
		await daemon.close();
	});

	it('registers every device as enabled and restores it when disabled', async () => {
		const repository = new MemoryConfigRepository();
		const backend = new ConfigurableBackend(['configurable:light-1']);
		const daemon = await startTestDaemon(repository, backend);
		const registration = await request(daemon.socketPath, 'device.config.get', {
			deviceId: 'configurable:light-1',
		});

		expect(registration).toMatchObject({
			values: { enabled: true, brightness: 10 },
		});
		expect(
			(registration as DeviceConfiguration).settings.find(
				(setting) => setting.key === 'enabled',
			),
		).toMatchObject({ kind: 'boolean', defaultValue: true });
		await emitWorking(daemon.socketPath);
		await request(daemon.socketPath, 'device.config.update', {
			deviceId: 'configurable:light-1',
			values: { enabled: false },
		});

		expect(repository.config.devices['configurable:light-1']).toEqual({
			enabled: false,
			brightness: 10,
		});
		expect(backend.restores).toBeGreaterThan(0);
		await daemon.close();
	});

	it('drives and restores a preview without changing Agent leases', async () => {
		const repository = new MemoryConfigRepository();
		const backend = new ConfigurableBackend(['configurable:light-1']);
		const daemon = await startTestDaemon(repository, backend);

		await request(daemon.socketPath, 'preview.start', { state: 'working' });
		expect(await request(daemon.socketPath, 'preview.getFrame', {})).toMatchObject({
			active: true,
			state: 'working',
			effect: 'breathe',
		});
		await request(daemon.socketPath, 'preview.update', { state: 'error' });
		expect(backend.visualCommits.at(-1)?.semanticState).toBe('error');
		await request(daemon.socketPath, 'preview.stop', {});
		expect(await request(daemon.socketPath, 'preview.getFrame', {})).toEqual({
			active: false,
		});
		expect(backend.restores).toBeGreaterThan(0);
		expect(await request(daemon.socketPath, 'daemon.getStatus', {})).toMatchObject({
			currentState: 'idle',
		});
		await daemon.close();
	});

	it('keeps the old file, device values and running visual effect when commit fails', async () => {
		const repository = new MemoryConfigRepository();
		repository.failCommit = true;
		repository.commitDelayMs = 150;
		const backend = new ConfigurableBackend(['configurable:light-1']);
		const daemon = await startTestDaemon(repository, backend);
		await emitWorking(daemon.socketPath);
		const oldConfig = structuredClone(repository.config);
		const candidate = createDefaultConfig();
		candidate.devices['configurable:light-1'] = { brightness: 80 };
		candidate.profiles.working = {
			color: '#FF0000',
			effect: 'static',
			hardwareIntensity: 1,
			intensity: 1,
		};

		await expect(
			request(daemon.socketPath, 'config.update', { config: candidate }),
		).rejects.toThrow('injected commit failure');

		expect(repository.config).toEqual(oldConfig);
		expect(repository.discards).toBe(1);
		expect(backend.values('configurable:light-1')).toEqual({ brightness: 10 });
		expect(backend.visualCommits.at(-1)).toMatchObject({
			hardwareIntensity: oldConfig.profiles.working.hardwareIntensity,
			semanticState: 'working',
		});
		expect(backend.visualCommits.at(-1)?.color).not.toEqual({ red: 255, green: 0, blue: 0 });
		expect(backend.deliveredBrightnesses).not.toContain(80);
		expect(await request(daemon.socketPath, 'config.get', {})).toEqual(oldConfig);
		await daemon.close();
	});

	it('rolls back earlier devices when a later device rejects configuration', async () => {
		const repository = new MemoryConfigRepository();
		const backend = new ConfigurableBackend(['configurable:light-1', 'configurable:light-2']);
		const daemon = await startTestDaemon(repository, backend);
		backend.failDeviceId = 'configurable:light-2';
		const candidate = createDefaultConfig();
		candidate.devices['configurable:light-1'] = { brightness: 20 };
		candidate.devices['configurable:light-2'] = { brightness: 30 };

		await expect(
			request(daemon.socketPath, 'config.update', { config: candidate }),
		).rejects.toThrow('injected device configuration failure');

		expect(backend.values('configurable:light-1')).toEqual({ brightness: 10 });
		expect(backend.values('configurable:light-2')).toEqual({ brightness: 10 });
		expect(repository.config).toEqual(createDefaultConfig());
		expect(repository.discards).toBe(1);
		await daemon.close();
	});
});

class MemoryConfigRepository implements DaemonConfigRepository {
	config = createDefaultConfig();
	discards = 0;
	commitDelayMs = 0;
	failCommit = false;

	async load(): Promise<AgentGlowConfig> {
		return structuredClone(this.config);
	}

	async prepare(config: AgentGlowConfig): Promise<PreparedConfigWrite> {
		const candidate = structuredClone(config);
		let pending = true;
		return {
			commit: async () => {
				if (!pending) throw new Error('prepared write is no longer pending');
				pending = false;
				if (this.commitDelayMs > 0) await delay(this.commitDelayMs);
				if (this.failCommit) throw new Error('injected commit failure');
				this.config = candidate;
			},
			discard: async () => {
				if (!pending) {
					if (this.failCommit) this.discards += 1;
					return;
				}
				pending = false;
				this.discards += 1;
			},
		};
	}
}

class ConfigurableBackend implements LightingBackend {
	readonly id = 'configurable';
	readonly deliveredBrightnesses: number[] = [];
	readonly visualCommits: StaticVisualState[] = [];
	restores = 0;
	readonly #devices: readonly DeviceDescriptor[];
	readonly #values = new Map<string, DeviceConfigurationValues>();
	failDeviceId: string | undefined;

	constructor(deviceIds: readonly string[]) {
		this.#devices = deviceIds.map((id) => ({
			id,
			name: id,
			capabilities: ['brightness'],
		}));
		for (const id of deviceIds) this.#values.set(id, { brightness: 10 });
	}

	getHealth(): 'healthy' {
		return 'healthy';
	}

	async discoverDevices(): Promise<readonly DeviceDescriptor[]> {
		return this.#devices;
	}

	async getDeviceConfiguration(deviceId: string): Promise<DeviceConfiguration> {
		return {
			deviceId,
			settings: [
				{
					key: 'brightness',
					label: 'Brightness',
					kind: 'integer',
					defaultValue: 10,
					minimum: 0,
					maximum: 100,
					step: 1,
				},
			],
			values: this.values(deviceId),
		};
	}

	async updateDeviceConfiguration(
		deviceId: string,
		values: DeviceConfigurationValues,
	): Promise<void> {
		if (this.failDeviceId === deviceId && values.brightness !== 10) {
			throw new Error('injected device configuration failure');
		}
		this.#values.set(deviceId, { ...values });
	}

	async captureSnapshot(deviceId: string): Promise<BackendSnapshot> {
		return { backendId: this.id, deviceId, value: null };
	}

	async applyVisualState(
		_deviceId: string,
		visualState: StaticVisualState,
	): Promise<BackendApplyResult> {
		this.visualCommits.push(structuredClone(visualState));
		this.deliveredBrightnesses.push(this.values(_deviceId).brightness as number);
		return { requested: visualState, applied: visualState, degraded: false };
	}

	async restoreSnapshot(): Promise<void> {
		this.restores += 1;
	}

	async close(): Promise<void> {}

	values(deviceId: string): DeviceConfigurationValues {
		const values = this.#values.get(deviceId);
		if (!values) throw new Error(`Unknown fixture device: ${deviceId}`);
		return { ...values };
	}
}

async function startTestDaemon(configRepository: DaemonConfigRepository, backend: LightingBackend) {
	const directory = await mkdtemp(path.join(tmpdir(), 'agent-glow-daemon-config-'));
	temporaryDirectories.push(directory);
	return startDaemonServer('test', path.join(directory, 'runtime', 'daemon.sock'), backend, {
		configRepository,
	});
}

function request(socketPath: string, method: string, params: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = '';
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
		});
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf('\n');
			if (newlineIndex < 0) return;
			const response = JSON.parse(buffer.slice(0, newlineIndex)) as {
				readonly error?: { readonly message: string };
				readonly result?: unknown;
			};
			socket.destroy();
			if (response.error) reject(new Error(response.error.message));
			else resolve(response.result);
		});
		socket.once('error', reject);
	});
}

function emitWorking(socketPath: string): Promise<unknown> {
	return request(socketPath, 'event.emit', {
		event: {
			version: 1,
			source: 'test',
			sessionId: 'configuration',
			state: 'working',
			phase: 'enter',
		},
	});
}
