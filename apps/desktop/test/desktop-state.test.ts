import { createDefaultConfig } from '@agent-glow/config';
import type { AgentGlowConfig } from '@agent-glow/protocol/config';
import { observable } from 'mobx';
import { describe, expect, it, vi } from 'vitest';

import { ConfigAutoSaver, DesktopState, waitForDaemonReady } from '../src/desktop-state.js';
import { IntegrationManager } from '../src/integration-manager.js';
import type { AgentGlowRpcClient } from '../src/rpc-client.js';
import type { ServiceClient } from '../src/service-client.js';

describe('ConfigAutoSaver', () => {
	it('coalesces pending edits and applies only the latest configuration', async () => {
		vi.useFakeTimers();
		const applied: number[] = [];
		const update = vi.fn(async (config) => config);
		const saver = new ConfigAutoSaver(
			update,
			(config) => applied.push(config.rendering.transitionMs),
			() => undefined,
			250,
		);
		const first = createDefaultConfig();
		first.rendering.transitionMs = 100;
		const latest = createDefaultConfig();
		latest.rendering.transitionMs = 700;

		saver.schedule(first);
		saver.schedule(latest);
		await vi.advanceTimersByTimeAsync(250);

		expect(update).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledWith(latest);
		expect(applied).toEqual([700]);
		vi.useRealTimers();
	});

	it('converts MobX observable configurations into plain save snapshots', async () => {
		const update = vi.fn(async (config) => config);
		const saver = new ConfigAutoSaver(
			update,
			() => undefined,
			() => undefined,
			0,
		);
		const config = observable(createDefaultConfig()) as AgentGlowConfig;
		const working = config.profiles.working;
		if (working.effect === 'static') throw new Error('Working fixture must animate');
		working.startColor = '#123456';

		expect(() => saver.schedule(config)).not.toThrow();
		await saver.flush();

		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({
				profiles: expect.objectContaining({
					working: expect.objectContaining({ startColor: '#123456' }),
				}),
			}),
		);
	});

	it('serializes nested proxy values as a JSON configuration snapshot', async () => {
		const update = vi.fn(async (config) => config);
		const saver = new ConfigAutoSaver(
			update,
			() => undefined,
			() => undefined,
			0,
		);
		const config = createDefaultConfig();
		config.devices['asusd:slash-test'] = new Proxy({ enabled: true, brightness: 128 }, {});

		expect(() => saver.schedule(config)).not.toThrow();
		await saver.flush();

		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({
				devices: {
					'asusd:slash-test': { enabled: true, brightness: 128 },
				},
			}),
		);
	});

	it('keeps draining when a newer edit arrives during a request', async () => {
		let release: (() => void) | undefined;
		const calls: number[] = [];
		const update = vi.fn(async (config) => {
			calls.push(config.rendering.transitionMs);
			if (calls.length === 1)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return config;
		});
		const saver = new ConfigAutoSaver(
			update,
			() => undefined,
			() => undefined,
			0,
		);
		const first = createDefaultConfig();
		first.rendering.transitionMs = 100;
		const latest = createDefaultConfig();
		latest.rendering.transitionMs = 800;

		saver.schedule(first);
		const flushing = saver.flush();
		await Promise.resolve();
		saver.schedule(latest);
		release?.();
		await flushing;

		expect(calls).toEqual([100, 800]);
	});
});

describe('DesktopState service switch', () => {
	it('keeps the requested disabled state while systemd is stopping the service', async () => {
		let release: (() => void) | undefined;
		const serviceClient: ServiceClient = {
			getStatus: vi.fn(async () => ({ enabled: false, running: false })),
			setEnabled: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			),
		};
		const state = new DesktopState(
			{} as AgentGlowRpcClient,
			serviceClient,
			new IntegrationManager('/tmp/agent-glow-test-cli', {
				codexHooksPath: '/tmp/agent-glow-test-codex-hooks.json',
				openCodePluginPath: '/tmp/agent-glow-test-opencode-plugin.js',
			}),
		);
		state.service = { enabled: true, running: true };
		const working = state.config.profiles.working;
		if (working.effect === 'static') throw new Error('Working fixture must animate');
		working.startColor = '#123456';

		const stopping = state.setServiceEnabled(false);

		expect(state.service).toEqual({ enabled: false, running: false });
		expect(state.serviceBusy).toBe(true);
		expect(serviceClient.setEnabled).toHaveBeenCalledWith(false);
		release?.();
		await stopping;

		expect(serviceClient.getStatus).toHaveBeenCalledOnce();
		expect(state.service).toEqual({ enabled: false, running: false });
		const preserved = state.config.profiles.working;
		if (preserved.effect === 'static') throw new Error('Working fixture must animate');
		expect(preserved.startColor).toBe('#123456');
		expect(state.error).toBeUndefined();
		expect(state.serviceBusy).toBe(false);
	});

	it('waits for the daemon socket to become ready after systemd starts', async () => {
		const getStatus = vi
			.fn<AgentGlowRpcClient['getStatus']>()
			.mockRejectedValueOnce(
				Object.assign(new Error('connect ENOENT /run/user/1000/agent-glow/daemon.sock'), {
					code: 'ENOENT',
				}),
			)
			.mockResolvedValue({ lifecycle: 'running', currentState: 'idle' });

		await expect(
			waitForDaemonReady({ getStatus } as unknown as AgentGlowRpcClient, 2, 0),
		).resolves.toBeUndefined();

		expect(getStatus).toHaveBeenCalledTimes(2);
	});
});
