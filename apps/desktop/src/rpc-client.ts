import { createConnection } from 'node:net';

import { validateConfigValue } from '@agent-glow/config';
import type { AgentGlowConfig } from '@agent-glow/protocol/config';
import type { DeviceDescriptor } from '@agent-glow/protocol/device';
import type {
	DeviceConfiguration,
	DeviceConfigurationValues,
} from '@agent-glow/protocol/device-configuration';
import type { DiagnosticsResult, PreviewFrameResult } from '@agent-glow/protocol/rpc';

import { resolveSocketPath } from './socket-path.js';

const REQUEST_TIMEOUT_MS = 3000;

export interface DaemonStatus {
	readonly lifecycle: 'starting' | 'running' | 'stopping';
	readonly currentState: string;
}

export interface AgentGlowRpcClient {
	getStatus(): Promise<DaemonStatus>;
	getConfig(): Promise<AgentGlowConfig>;
	updateConfig(config: AgentGlowConfig): Promise<AgentGlowConfig>;
	listDevices(): Promise<readonly DeviceDescriptor[]>;
	getDeviceConfiguration(deviceId: string): Promise<DeviceConfiguration>;
	updateDeviceConfiguration(
		deviceId: string,
		values: DeviceConfigurationValues,
	): Promise<DeviceConfiguration>;
	getDiagnostics(): Promise<DiagnosticsResult>;
	startPreview(state: string): Promise<void>;
	updatePreview(state: string): Promise<void>;
	stopPreview(): Promise<void>;
	getPreviewFrame(): Promise<PreviewFrameResult>;
}

export class SocketAgentGlowRpcClient implements AgentGlowRpcClient {
	readonly #socketPath: string;

	constructor(socketPath = resolveSocketPath()) {
		this.#socketPath = socketPath;
	}

	async getStatus(): Promise<DaemonStatus> {
		const value = await request(this.#socketPath, 'daemon.getStatus', {});
		if (
			!value ||
			typeof value !== 'object' ||
			!('lifecycle' in value) ||
			!('currentState' in value) ||
			typeof value.lifecycle !== 'string' ||
			typeof value.currentState !== 'string'
		) {
			throw new Error('daemon 返回了无效状态。');
		}
		return value as DaemonStatus;
	}

	async getConfig(): Promise<AgentGlowConfig> {
		return validateConfigValue(await request(this.#socketPath, 'config.get', {}));
	}

	async updateConfig(config: AgentGlowConfig): Promise<AgentGlowConfig> {
		return validateConfigValue(await request(this.#socketPath, 'config.update', { config }));
	}

	async listDevices(): Promise<readonly DeviceDescriptor[]> {
		const value = await request(this.#socketPath, 'device.list', {});
		if (!value || typeof value !== 'object' || !('devices' in value)) {
			throw new Error('daemon 返回了无效设备列表。');
		}
		return value.devices as readonly DeviceDescriptor[];
	}

	async getDeviceConfiguration(deviceId: string): Promise<DeviceConfiguration> {
		return (await request(this.#socketPath, 'device.config.get', {
			deviceId,
		})) as DeviceConfiguration;
	}

	async updateDeviceConfiguration(
		deviceId: string,
		values: DeviceConfigurationValues,
	): Promise<DeviceConfiguration> {
		return (await request(this.#socketPath, 'device.config.update', {
			deviceId,
			values,
		})) as DeviceConfiguration;
	}

	async getDiagnostics(): Promise<DiagnosticsResult> {
		return (await request(this.#socketPath, 'diagnostics.get', {})) as DiagnosticsResult;
	}

	async startPreview(state: string): Promise<void> {
		await request(this.#socketPath, 'preview.start', { state });
	}

	async updatePreview(state: string): Promise<void> {
		await request(this.#socketPath, 'preview.update', { state });
	}

	async stopPreview(): Promise<void> {
		await request(this.#socketPath, 'preview.stop', {});
	}

	async getPreviewFrame(): Promise<PreviewFrameResult> {
		return (await request(this.#socketPath, 'preview.getFrame', {})) as PreviewFrameResult;
	}
}

export function request(socketPath: string, method: string, params: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = '';
		let settled = false;
		const finish = (error?: Error, value?: unknown): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		socket.setEncoding('utf8');
		socket.setTimeout(REQUEST_TIMEOUT_MS);
		socket.once('connect', () => {
			socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
		});
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline)) as {
					readonly error?: { readonly message?: unknown };
					readonly result?: unknown;
				};
				if (response.error) {
					finish(
						new Error(
							typeof response.error.message === 'string'
								? response.error.message
								: 'daemon 请求失败。',
						),
					);
				} else {
					finish(undefined, response.result);
				}
			} catch {
				finish(new Error('daemon 返回了无效 JSON。'));
			}
		});
		socket.once('timeout', () => finish(new Error('daemon 请求超时。')));
		socket.once('error', (error) => finish(error));
	});
}
