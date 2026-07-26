import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createDefaultConfig, type PreparedConfigWrite } from '@agent-glow/config';
import type {
	BackendApplyResult,
	BackendLifecycleEvent,
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
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonConfigRepository } from '../src/config.js';
import { startDaemonServer } from '../src/server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe('P5 service lifecycle', () => {
	it('serves its socket while unavailable and discovers devices when the backend appears', async () => {
		const backend = new LifecycleBackend(false);
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const daemon = await startTestDaemon(backend);

		expect(await request(daemon.socketPath, 'device.list', {})).toEqual({ devices: [] });
		expect(await request(daemon.socketPath, 'diagnostics.get', {})).toMatchObject({
			service: {
				entryPath: expect.stringMatching(/^\//u),
				runtimePath: process.execPath,
			},
			backend: { id: 'lifecycle', health: 'unavailable' },
			devices: [],
		});
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('startup=true'));

		backend.setAvailable(true);
		await waitFor(async () => {
			const result = (await request(daemon.socketPath, 'device.list', {})) as {
				readonly devices: readonly DeviceDescriptor[];
			};
			return result.devices.length === 1;
		});

		expect(await request(daemon.socketPath, 'device.list', {})).toEqual({
			devices: [backend.device],
		});
		expect(backend.commits).toEqual([]);
		expect(await request(daemon.socketPath, 'diagnostics.get', {})).toMatchObject({
			backend: { id: 'lifecycle', health: 'healthy' },
		});
		const restoresBeforeTakeover = backend.restoreAttempts;
		await request(daemon.socketPath, 'event.emit', {
			event: {
				version: 1,
				source: 'test',
				sessionId: 'system-default',
				state: 'working',
				phase: 'enter',
			},
		});
		expect(backend.commits.at(-1)?.semanticState).toBe('working');
		await request(daemon.socketPath, 'event.clear', {
			source: 'test',
			sessionId: 'system-default',
		});
		expect(backend.restoreAttempts).toBe(restoresBeforeTakeover + 1);
		await daemon.close();
	});

	it('rejects shutdown at the total deadline and force-closes the backend', async () => {
		const backend = new LifecycleBackend(true);
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const daemon = await startTestDaemon(backend, 40);
		backend.hangApply = true;
		void request(daemon.socketPath, 'event.emit', {
			event: {
				version: 1,
				source: 'test',
				sessionId: 'shutdown',
				state: 'working',
				phase: 'enter',
			},
		}).catch(() => undefined);
		await waitFor(() => backend.applyAttempts >= 1);

		const startedAt = performance.now();
		await expect(daemon.close()).rejects.toThrow('Daemon shutdown exceeded 40 ms');
		expect(performance.now() - startedAt).toBeLessThan(250);
		expect(backend.closed).toBe(true);
		expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('shutdown timed out'));
	});

	it('atomically clears lifecycle leases before applying a completion pulse', async () => {
		const backend = new LifecycleBackend(true);
		const daemon = await startTestDaemon(backend);
		const session = { source: 'zcode', sessionId: 'zcode-session' };
		await request(daemon.socketPath, 'event.emit', {
			event: {
				version: 1,
				...session,
				state: 'working',
				phase: 'enter',
			},
		});
		await request(daemon.socketPath, 'event.emit', {
			event: {
				version: 1,
				...session,
				state: 'tool_use',
				phase: 'enter',
			},
		});

		expect(
			await request(daemon.socketPath, 'event.transition', {
				...session,
				clearStates: ['waiting_permission', 'tool_use', 'working'],
				event: { state: 'success', phase: 'pulse', ttlMs: 10 },
			}),
		).toMatchObject({ currentState: 'success' });
		expect(backend.commits.at(-1)?.semanticState).toBe('success');

		await delay(15);
		expect(await request(daemon.socketPath, 'daemon.getStatus', {})).toMatchObject({
			currentState: 'idle',
		});
		await daemon.close();
	});
});

class LifecycleBackend implements LightingBackend {
	readonly id = 'lifecycle';
	readonly device: DeviceDescriptor = {
		id: 'lifecycle:light-1',
		name: 'Lifecycle fixture',
		capabilities: ['static_color'],
	};
	readonly commits: StaticVisualState[] = [];
	applyAttempts = 0;
	closed = false;
	hangApply = false;
	restoreAttempts = 0;
	#available: boolean;
	#listener: ((event: BackendLifecycleEvent) => void) | undefined;

	constructor(available: boolean) {
		this.#available = available;
	}

	getHealth(): 'healthy' | 'unavailable' {
		return this.#available && !this.closed ? 'healthy' : 'unavailable';
	}

	async discoverDevices(): Promise<readonly DeviceDescriptor[]> {
		if (!this.#available) throw new Error('fixture service unavailable');
		return [this.device];
	}

	async getDeviceConfiguration(deviceId: string): Promise<DeviceConfiguration> {
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
		_visualStateDeviceId: string,
		visualState: StaticVisualState,
	): Promise<BackendApplyResult> {
		this.applyAttempts += 1;
		if (this.hangApply) await new Promise<never>(() => undefined);
		this.commits.push(visualState);
		return { requested: visualState, applied: visualState, degraded: false };
	}

	async restoreSnapshot(): Promise<void> {
		this.restoreAttempts += 1;
	}

	watchLifecycle(listener: (event: BackendLifecycleEvent) => void): () => void {
		this.#listener = listener;
		return () => {
			this.#listener = undefined;
		};
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	setAvailable(available: boolean): void {
		this.#available = available;
		this.#listener?.({ type: 'availability', available });
	}
}

class MemoryConfigRepository implements DaemonConfigRepository {
	readonly config = createDefaultConfig();

	async load(): Promise<AgentGlowConfig> {
		return structuredClone(this.config);
	}

	async prepare(): Promise<PreparedConfigWrite> {
		return {
			commit: async () => undefined,
			discard: async () => undefined,
		};
	}
}

async function startTestDaemon(backend: LightingBackend, shutdownTimeoutMs?: number) {
	const directory = await mkdtemp(path.join(tmpdir(), 'agent-glow-service-lifecycle-'));
	temporaryDirectories.push(directory);
	return startDaemonServer('test', path.join(directory, 'runtime', 'daemon.sock'), backend, {
		configRepository: new MemoryConfigRepository(),
		...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
	});
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await predicate()) return;
		await delay(5);
	}
	throw new Error('Timed out waiting for fixture state');
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
		socket.once('close', () => {
			if (!buffer.includes('\n')) reject(new Error('Daemon connection closed'));
		});
	});
}
