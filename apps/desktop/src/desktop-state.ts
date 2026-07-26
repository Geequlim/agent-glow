import { spawn } from 'node:child_process';
import path from 'node:path';

import { createDefaultConfig, validateConfigValue } from '@agent-glow/config';
import type { AgentGlowConfig, VisualProfile } from '@agent-glow/protocol/config';
import type { DeviceDescriptor } from '@agent-glow/protocol/device';
import type {
	DeviceConfiguration,
	DeviceConfigurationValue,
} from '@agent-glow/protocol/device-configuration';
import type { DiagnosticsResult } from '@agent-glow/protocol/rpc';
import { makeAutoObservable, runInAction } from 'mobx';

import {
	SocketAgentGlowRpcClient,
	type AgentGlowRpcClient,
	type DaemonStatus,
} from './rpc-client.js';
import { SystemdServiceClient, type ServiceClient, type ServiceStatus } from './service-client.js';
import {
	IntegrationManager,
	type IntegrationAction,
	type IntegrationId,
	type IntegrationPlan,
} from './integration-manager.js';

export const CONFIGURABLE_STATES = [
	'working',
	'tool_use',
	'waiting_permission',
	'success',
	'error',
	'paused',
] as const;
export type ConfigurableState = (typeof CONFIGURABLE_STATES)[number];

export const STATE_LABELS: Record<ConfigurableState, string> = {
	working: '处理中',
	tool_use: '调用工具',
	waiting_permission: '等待授权',
	success: '已完成',
	error: '发生错误',
	paused: '已暂停',
};

export interface AgentDetection {
	readonly id: IntegrationId;
	readonly available: boolean;
	readonly connected: boolean;
	readonly targetPath: string;
	readonly updateAvailable: boolean;
	readonly version?: string;
}

export class ConfigAutoSaver {
	readonly #update: (config: AgentGlowConfig) => Promise<AgentGlowConfig>;
	readonly #onApplied: (config: AgentGlowConfig) => void;
	readonly #onError: (error: unknown) => void;
	readonly #delayMs: number;
	#pending: AgentGlowConfig | undefined;
	#timer: NodeJS.Timeout | undefined;
	#running: Promise<void> | undefined;

	constructor(
		update: (config: AgentGlowConfig) => Promise<AgentGlowConfig>,
		onApplied: (config: AgentGlowConfig) => void,
		onError: (error: unknown) => void,
		delayMs = 250,
	) {
		this.#update = update;
		this.#onApplied = onApplied;
		this.#onError = onError;
		this.#delayMs = delayMs;
	}

	schedule(config: AgentGlowConfig): void {
		this.#pending = validateConfigValue(JSON.parse(JSON.stringify(config)));
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.flush();
		}, this.#delayMs);
	}

	async flush(): Promise<void> {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#running) {
			await this.#running;
			if (!this.#pending) return;
		}
		this.#running = this.#drain();
		try {
			await this.#running;
		} finally {
			this.#running = undefined;
		}
	}

	async #drain(): Promise<void> {
		while (this.#pending) {
			const candidate = this.#pending;
			this.#pending = undefined;
			try {
				const applied = await this.#update(candidate);
				if (!this.#pending) this.#onApplied(applied);
			} catch (error) {
				this.#onError(error);
			}
		}
	}
}

export class DesktopState {
	service: ServiceStatus = { enabled: false, running: false };
	daemon: DaemonStatus | undefined;
	config: AgentGlowConfig = createDefaultConfig();
	devices: readonly DeviceDescriptor[] = [];
	deviceConfigurations = new Map<string, DeviceConfiguration>();
	diagnostics: DiagnosticsResult | undefined;
	agents: readonly AgentDetection[] = [];
	loading = true;
	serviceBusy = false;
	configSaving = false;
	error: string | undefined;
	lastSavedAt: Date | undefined;

	readonly #rpc: AgentGlowRpcClient;
	readonly #serviceClient: ServiceClient;
	readonly #autoSaver: ConfigAutoSaver;
	readonly #integrations: IntegrationManager;

	constructor(
		rpc: AgentGlowRpcClient = new SocketAgentGlowRpcClient(),
		serviceClient: ServiceClient = new SystemdServiceClient(),
		integrations = new IntegrationManager(
			path.resolve(import.meta.dirname, '../../cli/dist/index.cjs'),
		),
	) {
		this.#rpc = rpc;
		this.#serviceClient = serviceClient;
		this.#integrations = integrations;
		this.#autoSaver = new ConfigAutoSaver(
			(config) => {
				runInAction(() => {
					this.configSaving = true;
					this.error = undefined;
				});
				return this.#rpc.updateConfig(config);
			},
			(config) => {
				runInAction(() => {
					this.config = structuredClone(config);
					this.configSaving = false;
					this.lastSavedAt = new Date();
				});
			},
			(error) => {
				runInAction(() => {
					this.configSaving = false;
					this.error = formatError(error);
				});
			},
		);
		makeAutoObservable(this, {}, { autoBind: true });
	}

	async refresh(): Promise<void> {
		runInAction(() => {
			this.loading = true;
			this.error = undefined;
		});
		try {
			const service = await this.#serviceClient.getStatus();
			let daemon: DaemonStatus | undefined;
			let config: AgentGlowConfig | undefined;
			let devices: readonly DeviceDescriptor[] = [];
			let diagnostics: DiagnosticsResult | undefined;
			const configurations = new Map<string, DeviceConfiguration>();
			if (service.running) {
				[daemon, config, devices, diagnostics] = await Promise.all([
					this.#rpc.getStatus(),
					this.#rpc.getConfig(),
					this.#rpc.listDevices(),
					this.#rpc.getDiagnostics(),
				]);
				await Promise.all(
					devices.map(async (device) => {
						configurations.set(
							device.id,
							await this.#rpc.getDeviceConfiguration(device.id),
						);
					}),
				);
			}
			const agents = await detectAgents(this.#integrations);
			runInAction(() => {
				this.service = service;
				this.daemon = daemon;
				if (config) this.config = structuredClone(config);
				this.devices = devices;
				this.deviceConfigurations = configurations;
				this.diagnostics = diagnostics;
				this.agents = agents;
			});
		} catch (error) {
			runInAction(() => {
				this.error = formatError(error);
			});
		} finally {
			runInAction(() => {
				this.loading = false;
			});
		}
	}

	async setServiceEnabled(enabled: boolean): Promise<void> {
		this.serviceBusy = true;
		this.error = undefined;
		this.service = { enabled, running: enabled };
		try {
			await this.#serviceClient.setEnabled(enabled);
			if (enabled) await waitForDaemonReady(this.#rpc);
			await this.refresh();
		} catch (error) {
			const message = formatError(error);
			await this.refresh();
			this.error = message;
		} finally {
			this.serviceBusy = false;
		}
	}

	updateProfile(state: ConfigurableState, profile: VisualProfile): void {
		this.config.profiles[state] = structuredClone(profile);
		this.#scheduleConfig();
	}

	updateTransition(transitionMs: number): void {
		this.config.rendering.transitionMs = transitionMs;
		this.#scheduleConfig();
	}

	updateRetainedStateTimeout(timeoutMs: number): void {
		this.config.daemon.retainedStateTimeoutMs = timeoutMs;
		this.#scheduleConfig();
	}

	updatePowerSavingMode(enabled: boolean): void {
		this.config.daemon.powerSavingMode = enabled;
		this.#scheduleConfig();
	}

	restoreDefaultStyles(): void {
		const defaults = createDefaultConfig();
		this.config.profiles = structuredClone(defaults.profiles);
		this.config.daemon.frameRate = defaults.daemon.frameRate;
		this.config.daemon.retainedStateTimeoutMs = defaults.daemon.retainedStateTimeoutMs;
		this.config.rendering.transitionMs = defaults.rendering.transitionMs;
		this.#scheduleConfig();
	}

	async updateDeviceSetting(
		deviceId: string,
		key: string,
		value: DeviceConfigurationValue,
	): Promise<void> {
		this.error = undefined;
		try {
			const updated = await this.#rpc.updateDeviceConfiguration(deviceId, {
				[key]: value,
			});
			runInAction(() => {
				this.deviceConfigurations.set(deviceId, updated);
				this.config.devices[deviceId] = { ...updated.values };
				this.lastSavedAt = new Date();
			});
		} catch (error) {
			runInAction(() => {
				this.error = formatError(error);
			});
		}
	}

	async flushPendingChanges(): Promise<void> {
		await this.#autoSaver.flush();
	}

	planIntegration(id: IntegrationId, action: IntegrationAction): Promise<IntegrationPlan> {
		return this.#integrations.plan(id, action);
	}

	async applyIntegration(plan: IntegrationPlan): Promise<boolean> {
		this.error = undefined;
		try {
			await this.#integrations.apply(plan);
			await this.refresh();
			return true;
		} catch (error) {
			this.error = formatError(error);
			return false;
		}
	}

	#scheduleConfig(): void {
		this.configSaving = true;
		this.error = undefined;
		this.#autoSaver.schedule(this.config);
	}
}

export async function waitForDaemonReady(
	rpc: AgentGlowRpcClient,
	attempts = 30,
	retryDelayMs = 100,
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			await rpc.getStatus();
			return;
		} catch (error) {
			lastError = error;
			if (attempt + 1 < attempts)
				await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
	throw new Error(`服务已启动，但 daemon 尚未就绪：${formatError(lastError)}`);
}

async function detectAgents(integrations: IntegrationManager): Promise<readonly AgentDetection[]> {
	const statuses = await integrations.statuses();
	return Promise.all(
		statuses.map(async (status) => {
			const executable = await detectExecutable(status.id);
			return {
				id: status.id,
				available: executable.available,
				connected: status.installed,
				targetPath: status.targetPath,
				updateAvailable: status.updateAvailable,
				...(executable.version ? { version: executable.version } : {}),
			};
		}),
	);
}

async function detectExecutable(
	executable: string,
): Promise<{ readonly available: boolean; readonly version?: string }> {
	if (executable === 'zcode') {
		return { available: await executableExists(executable) };
	}
	const version = await executableVersion(executable);
	return { available: version !== undefined, ...(version ? { version } : {}) };
}

function executableExists(executable: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn('which', [executable], {
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		child.once('error', () => resolve(false));
		child.once('close', (code) => resolve(code === 0));
	});
}

function executableVersion(executable: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn(executable, ['--version'], {
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		let stdout = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.once('error', () => resolve(undefined));
		child.once('close', (code) =>
			resolve(code === 0 ? stdout.trim().split('\n')[0] : undefined),
		);
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
