import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import type { BackendSnapshot, LightingBackend } from '@agent-glow/core/backend';
import { LeaseArbiter } from '@agent-glow/core/lease-arbiter';
import {
	getSemanticVisualEffect,
	renderVisualFrame,
	type SemanticVisualEffect,
} from '@agent-glow/core/semantic-visual-state';
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
	const sockets = new Set<Socket>();
	let activeRequests = 0;
	let animationGeneration = 0;
	let animationTimer: NodeJS.Timeout | undefined;
	let frameWrite: Promise<void> | undefined;
	let snapshots: readonly BackendSnapshot[];

	try {
		const devices = await backend.discoverDevices();
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
			case 'event.emit': {
				const currentState = arbiter.apply(request.params.event);
				await displayState(currentState);
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

	async function displayState(state: ReturnType<LeaseArbiter['currentState']>): Promise<void> {
		stopAnimation();
		if (frameWrite) await frameWrite;

		const effect = getSemanticVisualEffect(state);
		const devices = await backend.discoverDevices();
		await commitFrame(devices, renderVisualFrame(effect, 0));
		console.log(formatEffectLog(state, effect, backend.id, devices.length));

		if (effect.effect === 'static') return;

		const startedAt = performance.now();
		const generation = animationGeneration;
		animationTimer = setInterval(() => {
			if (generation !== animationGeneration || frameWrite) return;
			frameWrite = commitFrame(
				devices,
				renderVisualFrame(effect, performance.now() - startedAt),
			)
				.catch((error: unknown) => {
					console.error(
						`[agent-glow] animation stopped: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
					stopAnimation();
				})
				.finally(() => {
					frameWrite = undefined;
				});
		}, ANIMATION_FRAME_INTERVAL_MS);
	}

	async function commitFrame(
		devices: readonly DeviceDescriptor[],
		visualState: ReturnType<typeof renderVisualFrame>,
	): Promise<void> {
		let appliedDevices = 0;
		for (const device of devices) {
			try {
				const result = await backend.applyVisualState(device.id, visualState);
				appliedDevices += 1;
				if (result.degraded) {
					console.warn(
						`[agent-glow] device degraded device=${device.id} reason=${result.reason ?? 'unspecified'}`,
					);
				}
			} catch (error) {
				console.error(
					`[agent-glow] device apply failed device=${device.id} error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (appliedDevices === 0) throw new Error('No lighting device accepted the visual state');
	}

	function stopAnimation(): void {
		animationGeneration += 1;
		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
	}

	await listen(server, socketPath);
	await chmod(socketPath, 0o600);

	return {
		socketPath,
		close: async () => {
			const errors: unknown[] = [];
			stopAnimation();
			if (frameWrite) await captureError(() => frameWrite as Promise<void>, errors);
			for (const socket of sockets) socket.destroy();
			await captureError(() => closeServer(server), errors);
			const errorsBeforeRestore = errors.length;
			for (const snapshot of snapshots) {
				await captureError(() => backend.restoreSnapshot(snapshot), errors);
			}
			if (errors.length === errorsBeforeRestore) {
				console.log(
					`[agent-glow] restored snapshots backend=${backend.id} devices=${snapshots.length}`,
				);
			}
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
	return `[agent-glow] displaying ${common} intensity=${effect.minimumIntensity}..${effect.maximumIntensity} periodMs=${effect.periodMs} fps=${1000 / ANIMATION_FRAME_INTERVAL_MS}`;
}
