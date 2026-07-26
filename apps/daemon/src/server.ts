import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import type {
	BackendApplyResult,
	BackendLifecycleEvent,
	BackendSnapshot,
	LightingBackend,
	StaticVisualState,
} from '@agent-glow/core/backend';
import { mergeDeviceConfiguration } from '@agent-glow/core/device-configuration';
import {
	LatestValueScheduler,
	staticVisualStateFingerprint,
} from '@agent-glow/core/latest-value-scheduler';
import { LeaseArbiter } from '@agent-glow/core/lease-arbiter';
import {
	getSemanticVisualEffect,
	renderVisualFrame,
	type SemanticVisualEffect,
} from '@agent-glow/core/semantic-visual-state';
import { VisualStateEngine } from '@agent-glow/core/visual-state-engine';
import type { DeviceDescriptor } from '@agent-glow/protocol/device';
import {
	isProtocolMessageWithinLimit,
	PROTOCOL_LIMITS,
	PROTOCOL_VERSION,
} from '@agent-glow/protocol/limits';
import { type RpcRequest, RpcRequestSchema } from '@agent-glow/protocol/rpc';
import { Value } from '@sinclair/typebox/value';

import { createLightingBackend } from './backend-factory.js';
import { resolveSocketPath } from './socket-path.js';

const ANIMATION_FRAME_INTERVAL_MS = 100;

export interface DaemonServer {
	readonly socketPath: string;
	close(): Promise<void>;
}

export async function startDaemonServer(
	daemonVersion: string,
	socketPath = resolveSocketPath(),
	backend: LightingBackend = createLightingBackend(),
): Promise<DaemonServer> {
	await prepareSocketPath(socketPath);

	const arbiter = new LeaseArbiter();
	const visualEngine = new VisualStateEngine(getSemanticVisualEffect('idle'));
	const sockets = new Set<Socket>();
	let activeRequests = 0;
	let animationTimer: NodeJS.Timeout | undefined;
	let closing = false;
	let devices: readonly DeviceDescriptor[] = [];
	let displayedState: ReturnType<LeaseArbiter['currentState']> = 'idle';
	let lifecyclePaused = false;
	let lifecycleQueue = Promise.resolve();
	let snapshots: readonly BackendSnapshot[];
	const deviceDiagnostics = new Map<
		string,
		{
			readonly applied?: unknown;
			readonly details?: unknown;
			readonly reason?: string;
			readonly requested?: unknown;
			readonly status: 'ok' | 'degraded' | 'error';
		}
	>();
	const lastDegradationReasons = new Map<string, string>();
	const scheduler = new LatestValueScheduler<string, StaticVisualState, BackendApplyResult>({
		commit: (deviceId, visualState) => backend.applyVisualState(deviceId, visualState),
		fingerprint: staticVisualStateFingerprint,
		onResult: recordApplyResult,
		onError: recordApplyError,
	});
	try {
		devices = await backend.discoverDevices();
		snapshots = await Promise.all(devices.map((device) => backend.captureSnapshot(device.id)));
		await displayState('idle');
	} catch (error) {
		await backend.close();
		throw error;
	}
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding('utf8');
		socket.once('close', () => sockets.delete(socket));

		let buffer = '';
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			if (!isProtocolMessageWithinLimit(buffer)) {
				writeResponse(
					socket,
					errorResponse(null, -32_600, 'Request exceeds message limit'),
				);
				socket.end();
				return;
			}

			let newlineIndex = buffer.indexOf('\n');
			while (newlineIndex >= 0) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (line.trim()) void processLine(line, socket);
				newlineIndex = buffer.indexOf('\n');
			}
		});
	});

	async function processLine(line: string, socket: Socket): Promise<void> {
		if (activeRequests >= PROTOCOL_LIMITS.maxConcurrentRequests) {
			writeResponse(socket, errorResponse(null, -32_000, 'Too many concurrent requests'));
			return;
		}

		activeRequests += 1;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!Value.Check(RpcRequestSchema, parsed)) {
				writeResponse(
					socket,
					errorResponse(readRequestId(parsed), -32_600, 'Invalid request'),
				);
				return;
			}

			const request = parsed as RpcRequest;
			const result = await handleRequest(request);
			writeResponse(socket, { jsonrpc: '2.0', id: request.id, result });
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Internal error';
			writeResponse(socket, errorResponse(null, -32_603, message));
		} finally {
			activeRequests -= 1;
		}
	}

	async function handleRequest(request: RpcRequest): Promise<unknown> {
		switch (request.method) {
			case 'initialize':
				return { protocolVersion: PROTOCOL_VERSION, daemonVersion };
			case 'daemon.getStatus':
				return { lifecycle: 'running', currentState: arbiter.currentState() };
			case 'device.list':
				return { devices: await backend.discoverDevices() };
			case 'device.config.get':
				return backend.getDeviceConfiguration(request.params.deviceId);
			case 'device.config.update': {
				const current = await backend.getDeviceConfiguration(request.params.deviceId);
				const updated = mergeDeviceConfiguration(current, request.params.values);
				await backend.updateDeviceConfiguration(request.params.deviceId, updated.values);
				scheduler.invalidate(request.params.deviceId);
				await displayState(arbiter.currentState());
				return updated;
			}
			case 'diagnostics.get': {
				return {
					backend: { id: backend.id, health: backend.getHealth() },
					devices: devices.map((device) => ({
						deviceId: device.id,
						delivery: scheduler.stats(device.id),
						...(deviceDiagnostics.get(device.id) ?? { status: 'unknown' }),
					})),
				};
			}
			case 'event.emit': {
				const currentState = arbiter.apply(request.params.event);
				await displayState(currentState, request.params.event.phase === 'pulse');
				return { accepted: true, currentState };
			}
			case 'event.clear': {
				const { source, sessionId, state } = request.params;
				const cleared = arbiter.clear(source, sessionId, state);
				const currentState = arbiter.currentState();
				await displayState(currentState);
				return { cleared, currentState };
			}
			default:
				throw new Error('Unsupported RPC method');
		}
	}

	async function displayState(
		state: ReturnType<LeaseArbiter['currentState']>,
		restart = false,
	): Promise<void> {
		const effect = getSemanticVisualEffect(state);
		visualEngine.setTarget(effect, restart);
		displayedState = state;
		submitFrame(visualEngine.frame());
		await scheduler.flush();
		console.log(formatEffectLog(state, effect, backend.id, devices.length));
	}

	function submitFrame(visualState: StaticVisualState): void {
		for (const device of devices) scheduler.submit(device.id, visualState);
	}

	function recordApplyResult(deviceId: string, result: BackendApplyResult): void {
		deviceDiagnostics.set(deviceId, {
			status: result.degraded ? 'degraded' : 'ok',
			requested: result.requested,
			applied: result.applied,
			...(result.details ? { details: result.details } : {}),
			...(result.reason ? { reason: result.reason } : {}),
		});
		if (result.degraded) {
			const reason = result.reason ?? 'unspecified';
			if (lastDegradationReasons.get(deviceId) !== reason) {
				console.warn(`[agent-glow] device degraded device=${deviceId} reason=${reason}`);
				lastDegradationReasons.set(deviceId, reason);
			}
		} else {
			lastDegradationReasons.delete(deviceId);
		}
	}

	function recordApplyError(
		deviceId: string,
		error: unknown,
		consecutiveFailures: number,
		retryDelayMs: number,
	): void {
		const reason = error instanceof Error ? error.message : String(error);
		deviceDiagnostics.set(deviceId, { status: 'error', reason });
		if (consecutiveFailures === 1 || isPowerOfTwo(consecutiveFailures)) {
			console.error(
				`[agent-glow] device apply failed device=${deviceId} failures=${consecutiveFailures} retryMs=${retryDelayMs} error=${reason}`,
			);
		}
	}

	async function handleLifecycleEvent(event: BackendLifecycleEvent): Promise<void> {
		if (closing) return;
		if (event.type === 'availability' && !event.available) {
			lifecyclePaused = true;
			await scheduler.pause();
			for (const device of devices) {
				deviceDiagnostics.set(device.id, {
					status: 'error',
					reason: 'Backend service unavailable',
				});
			}
			console.warn(`[agent-glow] backend unavailable backend=${backend.id}`);
			return;
		}
		if (event.type === 'sleep' && event.sleeping) {
			lifecyclePaused = true;
			await scheduler.pause();
			await restoreBackendSnapshots(backend, snapshots);
			console.log(`[agent-glow] suspended backend=${backend.id}`);
			return;
		}
		await refreshDevices(event.type === 'sleep' ? 'resume' : 'service-restored');
	}

	async function refreshDevices(reason: string): Promise<void> {
		const refreshedDevices = await backend.discoverDevices();
		snapshots = await reconcileBackendSnapshots(backend, snapshots, refreshedDevices);
		devices = refreshedDevices;
		scheduler.invalidate();
		lifecyclePaused = false;
		scheduler.resume();
		submitFrame(visualEngine.frame());
		await scheduler.flush();
		console.log(
			`[agent-glow] backend refreshed backend=${backend.id} reason=${reason} devices=${devices.length}`,
		);
	}

	await listen(server, socketPath);
	await chmod(socketPath, 0o600);
	const stopLifecycleWatch = backend.watchLifecycle?.((event) => {
		lifecycleQueue = lifecycleQueue
			.then(() => handleLifecycleEvent(event))
			.catch((error: unknown) => {
				console.error(
					`[agent-glow] backend lifecycle handling failed error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
	});
	animationTimer = setInterval(() => {
		if (lifecyclePaused) return;
		const currentState = arbiter.currentState();
		const changed = currentState !== displayedState;
		if (changed) {
			visualEngine.setTarget(getSemanticVisualEffect(currentState));
			displayedState = currentState;
			console.log(
				formatEffectLog(
					currentState,
					getSemanticVisualEffect(currentState),
					backend.id,
					devices.length,
				),
			);
		}
		if (changed || visualEngine.isAnimating()) submitFrame(visualEngine.frame());
	}, ANIMATION_FRAME_INTERVAL_MS);

	return {
		socketPath,
		close: async () => {
			const errors: unknown[] = [];
			closing = true;
			stopLifecycleWatch?.();
			if (animationTimer) clearInterval(animationTimer);
			animationTimer = undefined;
			await captureError(() => lifecycleQueue, errors);
			await captureError(() => scheduler.close(), errors);
			for (const socket of sockets) socket.destroy();
			await captureError(() => closeServer(server), errors);
			await captureError(() => restoreBackendSnapshots(backend, snapshots), errors);
			await captureError(() => backend.close(), errors);
			await captureError(
				() =>
					unlink(socketPath).catch((error: unknown) => {
						if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
					}),
				errors,
			);
			if (errors.length > 0) throw new AggregateError(errors, 'Daemon shutdown failed');
		},
	};
}

export async function reconcileBackendSnapshots(
	backend: LightingBackend,
	snapshots: readonly BackendSnapshot[],
	devices: readonly DeviceDescriptor[],
): Promise<readonly BackendSnapshot[]> {
	const existingByDevice = new Map(
		snapshots.map((snapshot) => [snapshot.deviceId, snapshot] as const),
	);
	return Promise.all(
		devices.map(
			(device) => existingByDevice.get(device.id) ?? backend.captureSnapshot(device.id),
		),
	);
}

export async function restoreBackendSnapshots(
	backend: LightingBackend,
	snapshots: readonly BackendSnapshot[],
): Promise<void> {
	const errors: unknown[] = [];
	let restoredSnapshots = 0;
	for (const snapshot of snapshots) {
		try {
			await backend.restoreSnapshot(snapshot);
			restoredSnapshots += 1;
		} catch (error) {
			errors.push(error);
			console.error(
				`[agent-glow] snapshot restore failed device=${snapshot.deviceId} error=${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			try {
				const safeState = renderVisualFrame(getSemanticVisualEffect('idle'), 0);
				await backend.applyVisualState(snapshot.deviceId, safeState);
				console.warn(
					`[agent-glow] applied safe fallback device=${snapshot.deviceId} state=idle`,
				);
			} catch (fallbackError) {
				errors.push(fallbackError);
				console.error(
					`[agent-glow] safe fallback failed device=${snapshot.deviceId} error=${
						fallbackError instanceof Error
							? fallbackError.message
							: String(fallbackError)
					}`,
				);
			}
		}
	}
	if (restoredSnapshots === snapshots.length) {
		console.log(
			`[agent-glow] restored snapshots backend=${backend.id} devices=${snapshots.length}`,
		);
	}
	if (errors.length > 0) throw new AggregateError(errors, 'Backend snapshot restoration failed');
}

async function prepareSocketPath(socketPath: string): Promise<void> {
	const directory = path.dirname(socketPath);
	const existingDirectory = await lstat(directory).catch((error: unknown) => {
		if (isNodeError(error) && error.code === 'ENOENT') return undefined;
		throw error;
	});

	if (existingDirectory) {
		if (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink()) {
			throw new Error(`Unsafe socket directory: ${directory}`);
		}
		if ((existingDirectory.mode & 0o077) !== 0) {
			throw new Error(
				`Socket directory must not be accessible by group or others: ${directory}`,
			);
		}
	} else {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
	}

	const existing = await lstat(socketPath).catch((error: unknown) => {
		if (isNodeError(error) && error.code === 'ENOENT') return undefined;
		throw error;
	});
	if (existing) {
		const kind = existing.isSymbolicLink()
			? 'symbolic link'
			: existing.isSocket()
				? 'socket'
				: 'node';
		throw new Error(`Refusing to replace existing ${kind}: ${socketPath}`);
	}
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, resolve);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function writeResponse(socket: Socket, response: unknown): void {
	socket.write(`${JSON.stringify(response)}\n`);
}

function errorResponse(id: string | number | null, code: number, message: string): unknown {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

function readRequestId(value: unknown): string | number | null {
	if (!value || typeof value !== 'object' || !('id' in value)) return null;
	const id = value.id;
	return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

function isPowerOfTwo(value: number): boolean {
	return value > 0 && (value & (value - 1)) === 0;
}

async function captureError(operation: () => Promise<void>, errors: unknown[]): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(error);
	}
}

function toHexColor(color: {
	readonly red: number;
	readonly green: number;
	readonly blue: number;
}): string {
	return `#${[color.red, color.green, color.blue]
		.map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
		.join('')}`;
}

function formatEffectLog(
	state: ReturnType<LeaseArbiter['currentState']>,
	effect: SemanticVisualEffect,
	backendId: string,
	deviceCount: number,
): string {
	const common = `state=${state} effect=${effect.effect} color=${toHexColor(
		effect.color,
	)} rgbBrightness=software-scale hardwareBrightness=${effect.hardwareIntensity} backend=${backendId} devices=${deviceCount}`;
	if (effect.effect === 'static')
		return `[agent-glow] displaying ${common} intensity=${effect.intensity}`;
	if (effect.effect === 'breathe')
		return `[agent-glow] displaying ${common} intensity=${effect.minimumIntensity}..${effect.maximumIntensity} periodMs=${effect.periodMs} fps=${1000 / ANIMATION_FRAME_INTERVAL_MS}`;
	return `[agent-glow] displaying ${common} intensity=${effect.minimumIntensity}..${effect.maximumIntensity} pulses=${effect.pulseCount} durationMs=${effect.durationMs} fps=${1000 / ANIMATION_FRAME_INTERVAL_MS}`;
}
