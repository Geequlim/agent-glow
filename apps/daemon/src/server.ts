import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { validateConfigValue } from '@agent-glow/config';
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
import type { AgentGlowConfig } from '@agent-glow/protocol/config';
import type { DeviceDescriptor } from '@agent-glow/protocol/device';
import type {
	DeviceConfiguration,
	DeviceConfigurationValues,
} from '@agent-glow/protocol/device-configuration';
import {
	isProtocolMessageWithinLimit,
	PROTOCOL_LIMITS,
	PROTOCOL_VERSION,
} from '@agent-glow/protocol/limits';
import { type RpcRequest, RpcRequestSchema } from '@agent-glow/protocol/rpc';
import { Value } from '@sinclair/typebox/value';

import { createLightingBackend } from './backend-factory.js';
import {
	configuredVisualEffect,
	createFileConfigRepository,
	type DaemonConfigRepository,
} from './config.js';
import { resolveSocketPath } from './socket-path.js';

export interface DaemonServer {
	readonly socketPath: string;
	close(): Promise<void>;
}

export interface DaemonServerOptions {
	readonly configRepository?: DaemonConfigRepository;
	readonly shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const PREVIEW_TTL_MS = 15_000;
const DEVICE_ENABLED_SETTING = {
	key: 'enabled',
	label: '启用设备',
	description: '关闭后 AgentGlow 不再控制此设备。',
	kind: 'boolean',
	defaultValue: true,
} as const;

interface DeviceConfigurationPlan {
	readonly deviceId: string;
	readonly previousEnabled: boolean;
	readonly previousValues: DeviceConfigurationValues;
	readonly targetEnabled: boolean;
	readonly targetValues: DeviceConfigurationValues;
}

export async function startDaemonServer(
	daemonVersion: string,
	socketPath = resolveSocketPath(),
	backend: LightingBackend = createLightingBackend(),
	options: DaemonServerOptions = {},
): Promise<DaemonServer> {
	await prepareSocketPath(socketPath);

	const configRepository = options.configRepository ?? createFileConfigRepository();
	let config = validateConfigValue(structuredClone(await configRepository.load()));
	const arbiter = new LeaseArbiter(undefined, config.daemon.staleSessionTimeoutMs);
	const visualEngine = new VisualStateEngine(
		configuredVisualEffect(config, 'working'),
		undefined,
		config.rendering.transitionMs,
	);
	const sockets = new Set<Socket>();
	let activeRequests = 0;
	let animationTimer: NodeJS.Timeout | undefined;
	let previewTimer: NodeJS.Timeout | undefined;
	let previewState: Exclude<ReturnType<LeaseArbiter['currentState']>, 'idle'> | undefined;
	let stateSyncPending = false;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	let devices: readonly DeviceDescriptor[] = [];
	let displayedState: ReturnType<LeaseArbiter['currentState']> = 'idle';
	let lifecyclePaused = false;
	let lifecycleQueue = Promise.resolve();
	let configQueue = Promise.resolve();
	let snapshots: readonly BackendSnapshot[] = [];
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
	await scheduler.pause();
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
			case 'config.get':
				return enqueueConfigTransaction(() => Promise.resolve(structuredClone(config)));
			case 'config.validate':
				return enqueueConfigTransaction(async () => {
					validateConfigValue(request.params.config);
					await buildDeviceConfigurationPlans(request.params.config, devices);
					return { valid: true };
				});
			case 'config.update':
				return enqueueConfigTransaction(() => updateConfiguration(request.params.config));
			case 'device.list':
				return { devices };
			case 'device.config.get':
				return enqueueConfigTransaction(() =>
					getRegisteredDeviceConfiguration(request.params.deviceId),
				);
			case 'device.config.update':
				return enqueueConfigTransaction(async () => {
					const current = await getRegisteredDeviceConfiguration(request.params.deviceId);
					const updated = mergeDeviceConfiguration(current, request.params.values);
					const candidate = structuredClone(config);
					candidate.devices[request.params.deviceId] = { ...updated.values };
					await updateConfiguration(candidate);
					return getRegisteredDeviceConfiguration(request.params.deviceId);
				});
			case 'diagnostics.get': {
				return {
					backend: {
						id: backend.id,
						health: lifecyclePaused ? 'unavailable' : backend.getHealth(),
					},
					devices: devices.map((device) => ({
						deviceId: device.id,
						enabled: isDeviceEnabled(device.id),
						delivery: scheduler.stats(device.id),
						...(deviceDiagnostics.get(device.id) ?? { status: 'unknown' }),
					})),
				};
			}
			case 'preview.start':
			case 'preview.update':
				previewState = request.params.state;
				refreshPreviewTimer();
				await displayState(previewState, request.method === 'preview.start');
				return { active: true, state: previewState };
			case 'preview.stop':
				await stopPreview();
				return { active: false };
			case 'preview.getFrame': {
				if (!previewState) return { active: false };
				refreshPreviewTimer();
				const frame = visualEngine.frame();
				return {
					active: true,
					state: previewState,
					effect: configuredVisualEffect(config, previewState).effect,
					color: toHexColor(frame.color),
					intensity: frame.intensity,
				};
			}
			case 'event.emit': {
				const currentState = arbiter.apply(request.params.event);
				if (!previewState)
					await displayState(currentState, request.params.event.phase === 'pulse');
				return { accepted: true, currentState };
			}
			case 'event.clear': {
				const { source, sessionId, state } = request.params;
				const cleared = arbiter.clear(source, sessionId, state);
				const currentState = arbiter.currentState();
				if (!previewState) await displayState(currentState);
				return { cleared, currentState };
			}
			default:
				throw new Error('Unsupported RPC method');
		}
	}

	async function updateConfiguration(candidateValue: AgentGlowConfig): Promise<AgentGlowConfig> {
		const candidate = validateConfigValue(structuredClone(candidateValue));
		const plans = await buildDeviceConfigurationPlans(candidate, devices);
		const prepared = await configRepository.prepare(candidate);
		const resumeDelivery = !lifecyclePaused && displayedState !== 'idle';
		let deviceConfigurationApplied = false;
		await scheduler.pause();
		try {
			await applyDeviceConfigurationPlans(plans);
			deviceConfigurationApplied = true;
			await prepared.commit();
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			if (deviceConfigurationApplied) {
				await captureError(() => rollbackDeviceConfigurationPlans(plans), rollbackErrors);
			}
			await captureError(() => prepared.discard(), rollbackErrors);
			scheduler.invalidate();
			if (displayedState !== 'idle') submitFrame(visualEngine.frame());
			if (resumeDelivery && !lifecyclePaused) scheduler.resume();
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					'Configuration transaction failed',
				);
			}
			throw error;
		}

		const previousConfig = config;
		config = candidate;
		arbiter.setStaleLeaseTtlMs(config.daemon.staleSessionTimeoutMs);
		const currentState = previewState ?? arbiter.currentState();
		visualEngine.setTransitionDurationMs(config.rendering.transitionMs);
		if (
			currentState !== 'idle' &&
			!isDeepStrictEqual(previousConfig.profiles[currentState], config.profiles[currentState])
		) {
			visualEngine.reconfigure(
				configuredVisualEffect(config, currentState),
				config.rendering.transitionMs,
			);
		}
		displayedState = currentState;
		scheduler.invalidate();
		if (currentState !== 'idle') await restoreNewlyDisabledDevices(plans);
		if (currentState !== 'idle') {
			submitFrame(visualEngine.frame());
			if (resumeDelivery && !lifecyclePaused) scheduler.resume();
		}
		await scheduler.flush();
		startAnimationTimer();
		console.log(`[agent-glow] configuration updated version=${config.version}`);
		if (currentState === 'idle') {
			console.log(`[agent-glow] state=idle mode=system-default backend=${backend.id}`);
		} else {
			console.log(
				formatEffectLog(
					currentState,
					configuredVisualEffect(config, currentState),
					backend.id,
					devices.length,
					config.daemon.frameRate,
				),
			);
		}
		return structuredClone(config);
	}

	async function buildDeviceConfigurationPlans(
		candidate: AgentGlowConfig,
		targetDevices: readonly DeviceDescriptor[],
	): Promise<readonly DeviceConfigurationPlan[]> {
		return Promise.all(
			targetDevices.map(async (device) => {
				const backendCurrent = mergeDeviceConfiguration(
					await backend.getDeviceConfiguration(device.id),
					{},
				);
				const current = await getRegisteredDeviceConfiguration(device.id);
				const defaults: DeviceConfiguration = {
					...current,
					values: Object.fromEntries(
						current.settings.map((setting) => [setting.key, setting.defaultValue]),
					),
				};
				const target = mergeDeviceConfiguration(
					defaults,
					candidate.devices[device.id] ?? {},
				);
				return {
					deviceId: device.id,
					previousEnabled: readEnabled(current.values),
					previousValues: { ...backendCurrent.values },
					targetEnabled: readEnabled(target.values),
					targetValues: withoutEnabled(target.values),
				};
			}),
		);
	}

	async function getRegisteredDeviceConfiguration(
		deviceId: string,
	): Promise<DeviceConfiguration> {
		const registered = await backend.getDeviceConfiguration(deviceId);
		if (
			registered.settings.some((setting) => setting.key === DEVICE_ENABLED_SETTING.key) ||
			Object.hasOwn(registered.values, DEVICE_ENABLED_SETTING.key)
		) {
			throw new Error('Backend reserved device configuration key: enabled');
		}
		return {
			...registered,
			settings: [DEVICE_ENABLED_SETTING, ...registered.settings],
			values: {
				enabled: config.devices[deviceId]?.enabled ?? true,
				...registered.values,
			},
		};
	}

	async function applyDeviceConfigurationPlans(
		plans: readonly DeviceConfigurationPlan[],
	): Promise<void> {
		const applied: DeviceConfigurationPlan[] = [];
		try {
			for (const plan of plans) {
				await backend.updateDeviceConfiguration(plan.deviceId, plan.targetValues);
				applied.push(plan);
			}
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			await captureError(() => rollbackDeviceConfigurationPlans(applied), rollbackErrors);
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					'Device configuration apply failed',
				);
			}
			throw error;
		}
	}

	async function rollbackDeviceConfigurationPlans(
		plans: readonly DeviceConfigurationPlan[],
	): Promise<void> {
		const errors: unknown[] = [];
		for (const plan of [...plans].reverse()) {
			await captureError(
				() => backend.updateDeviceConfiguration(plan.deviceId, plan.previousValues),
				errors,
			);
		}
		if (errors.length > 0)
			throw new AggregateError(errors, 'Device configuration rollback failed');
	}

	async function restoreNewlyDisabledDevices(
		plans: readonly DeviceConfigurationPlan[],
	): Promise<void> {
		const snapshotByDevice = new Map(
			snapshots.map((snapshot) => [snapshot.deviceId, snapshot] as const),
		);
		for (const plan of plans) {
			if (!plan.previousEnabled || plan.targetEnabled) continue;
			const snapshot = snapshotByDevice.get(plan.deviceId);
			if (snapshot) await backend.restoreSnapshot(snapshot);
		}
	}

	function enqueueConfigTransaction<T>(operation: () => Promise<T>): Promise<T> {
		const result = configQueue.then(operation);
		configQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function displayState(
		state: ReturnType<LeaseArbiter['currentState']>,
		restart = false,
	): Promise<void> {
		if (state === 'idle') {
			await scheduler.pause();
			if (!lifecyclePaused) await restoreBackendSnapshots(backend, snapshots);
			displayedState = state;
			console.log(`[agent-glow] state=idle mode=system-default backend=${backend.id}`);
			return;
		}
		const effect = configuredVisualEffect(config, state);
		if (displayedState === 'idle') {
			if (!lifecyclePaused) {
				snapshots = await Promise.all(
					devices.map((device) => backend.captureSnapshot(device.id)),
				);
			}
			visualEngine.reconfigure(effect, 0);
			visualEngine.setTransitionDurationMs(config.rendering.transitionMs);
		} else {
			visualEngine.setTarget(effect, restart);
		}
		displayedState = state;
		submitFrame(visualEngine.frame());
		if (!lifecyclePaused) scheduler.resume();
		await scheduler.flush();
		console.log(
			formatEffectLog(state, effect, backend.id, devices.length, config.daemon.frameRate),
		);
	}

	function submitFrame(visualState: StaticVisualState): void {
		for (const device of devices) {
			if (isDeviceEnabled(device.id)) scheduler.submit(device.id, visualState);
		}
	}

	function isDeviceEnabled(deviceId: string): boolean {
		return config.devices[deviceId]?.enabled !== false;
	}

	function refreshPreviewTimer(): void {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = setTimeout(() => {
			void enqueueConfigTransaction(stopPreview).catch((error: unknown) => {
				console.error(
					`[agent-glow] preview timeout recovery failed error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
		}, PREVIEW_TTL_MS);
	}

	async function stopPreview(): Promise<void> {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = undefined;
		if (!previewState) return;
		previewState = undefined;
		await displayState(arbiter.currentState());
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
		const refreshedSnapshots = await reconcileBackendSnapshots(
			backend,
			snapshots,
			refreshedDevices,
		);
		await applyDeviceConfigurationPlans(
			await buildDeviceConfigurationPlans(config, refreshedDevices),
		);
		devices = refreshedDevices;
		snapshots = refreshedSnapshots;
		scheduler.invalidate();
		lifecyclePaused = false;
		if (arbiter.currentState() === 'idle') {
			await scheduler.pause();
			if (reason !== 'startup') await restoreBackendSnapshots(backend, snapshots);
			displayedState = 'idle';
			console.log(
				`[agent-glow] state=idle mode=system-default backend=${backend.id} reason=${reason}`,
			);
		} else {
			scheduler.resume();
			submitFrame(visualEngine.frame());
		}
		await scheduler.flush();
		console.log(
			`[agent-glow] backend refreshed backend=${backend.id} reason=${reason} devices=${devices.length}`,
		);
	}

	const stopLifecycleWatch = backend.watchLifecycle?.((event) => {
		lifecycleQueue = lifecycleQueue
			.then(() => enqueueConfigTransaction(() => handleLifecycleEvent(event)))
			.catch((error: unknown) => {
				console.error(
					`[agent-glow] backend lifecycle handling failed error=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
	});
	await listen(server, socketPath);
	await chmod(socketPath, 0o600);
	try {
		await enqueueConfigTransaction(() => refreshDevices('startup'));
		console.log(`[agent-glow] backend ready backend=${backend.id} devices=${devices.length}`);
	} catch (error) {
		lifecyclePaused = true;
		await scheduler.pause();
		console.warn(
			`[agent-glow] backend unavailable backend=${backend.id} startup=true error=${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	startAnimationTimer();

	function startAnimationTimer(): void {
		if (animationTimer) clearInterval(animationTimer);
		animationTimer = setInterval(animate, 1000 / config.daemon.frameRate);
	}

	function animate(): void {
		if (lifecyclePaused) return;
		const currentState = previewState ?? arbiter.currentState();
		const changed = currentState !== displayedState;
		if (changed) {
			if (!stateSyncPending) {
				stateSyncPending = true;
				void enqueueConfigTransaction(() => displayState(currentState))
					.catch((error: unknown) => {
						console.error(
							`[agent-glow] state synchronization failed error=${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					})
					.finally(() => {
						stateSyncPending = false;
					});
			}
			return;
		}
		if (currentState !== 'idle' && visualEngine.isAnimating()) {
			submitFrame(visualEngine.frame());
		}
	}

	return {
		socketPath,
		close: () => {
			closePromise ??= closeWithinDeadline();
			return closePromise;
		},
	};

	async function closeWithinDeadline(): Promise<void> {
		const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		return withTimeout(
			async () => {
				const errors: unknown[] = [];
				closing = true;
				stopLifecycleWatch?.();
				if (animationTimer) clearInterval(animationTimer);
				animationTimer = undefined;
				if (previewTimer) clearTimeout(previewTimer);
				previewTimer = undefined;
				for (const socket of sockets) socket.destroy();
				await captureError(() => closeServer(server), errors);
				await captureError(
					() =>
						unlink(socketPath).catch((error: unknown) => {
							if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
						}),
					errors,
				);
				await captureError(() => lifecycleQueue, errors);
				await captureError(() => configQueue, errors);
				await captureError(() => scheduler.close(), errors);
				if (config.rendering.restoreOnExit) {
					await captureError(() => restoreBackendSnapshots(backend, snapshots), errors);
				}
				await captureError(() => backend.close(), errors);
				if (errors.length > 0) throw new AggregateError(errors, 'Daemon shutdown failed');
			},
			shutdownTimeoutMs,
			`Daemon shutdown exceeded ${shutdownTimeoutMs} ms`,
			() => {
				console.error(
					`[agent-glow] daemon shutdown timed out timeoutMs=${shutdownTimeoutMs}`,
				);
				void backend.close().catch((error: unknown) => {
					console.error(
						`[agent-glow] forced backend close failed error=${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				});
			},
		);
	}
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

function readEnabled(values: DeviceConfigurationValues): boolean {
	return values.enabled !== false;
}

function withoutEnabled(values: DeviceConfigurationValues): DeviceConfigurationValues {
	const { enabled: _enabled, ...backendValues } = values;
	return backendValues;
}

async function captureError(operation: () => Promise<void>, errors: unknown[]): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(error);
	}
}

async function withTimeout(
	operation: () => Promise<void>,
	timeoutMs: number,
	message: string,
	onTimeout?: () => void,
): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			operation(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					onTimeout?.();
					reject(new Error(message));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
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
	frameRate: number,
): string {
	const color =
		effect.effect === 'static'
			? `color=${toHexColor(effect.color)}`
			: `colors=${toHexColor(effect.startColor)}..${toHexColor(effect.endColor)}`;
	const common = `state=${state} effect=${effect.effect} ${color} rgbBrightness=software-scale hardwareBrightness=${effect.hardwareIntensity} backend=${backendId} devices=${deviceCount}`;
	if (effect.effect === 'static')
		return `[agent-glow] displaying ${common} intensity=${effect.intensity}`;
	if (effect.effect === 'breathe' || effect.effect === 'stream')
		return `[agent-glow] displaying ${common} intensity=${effect.minimumIntensity}..${effect.maximumIntensity} periodMs=${effect.periodMs} fps=${frameRate}`;
	return `[agent-glow] displaying ${common} intensity=${effect.minimumIntensity}..${effect.maximumIntensity} pulses=${effect.pulseCount} durationMs=${effect.durationMs} fps=${frameRate}`;
}
