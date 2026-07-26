import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { RpcRequestSchema } from '../src/rpc.js';

describe('RpcRequestSchema', () => {
	it('accepts every MVP method', () => {
		const requests = [
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: 1, clientName: 'agent-glow-cli' },
			},
			{ jsonrpc: '2.0', id: 2, method: 'daemon.getStatus', params: {} },
			{ jsonrpc: '2.0', id: 3, method: 'config.get', params: {} },
			{
				jsonrpc: '2.0',
				id: 4,
				method: 'config.validate',
				params: { config: validConfig },
			},
			{
				jsonrpc: '2.0',
				id: 5,
				method: 'config.update',
				params: { config: validConfig },
			},
			{ jsonrpc: '2.0', id: 6, method: 'device.list', params: {} },
			{
				jsonrpc: '2.0',
				id: 7,
				method: 'device.config.get',
				params: { deviceId: 'fake:light-1' },
			},
			{
				jsonrpc: '2.0',
				id: 8,
				method: 'device.config.update',
				params: {
					deviceId: 'fake:light-1',
					values: { 'states.working.brightness': 128 },
				},
			},
			{ jsonrpc: '2.0', id: 9, method: 'diagnostics.get', params: {} },
			{
				jsonrpc: '2.0',
				id: 10,
				method: 'preview.start',
				params: { state: 'working' },
			},
			{
				jsonrpc: '2.0',
				id: 11,
				method: 'preview.update',
				params: { state: 'waiting_permission' },
			},
			{ jsonrpc: '2.0', id: 12, method: 'preview.getFrame', params: {} },
			{ jsonrpc: '2.0', id: 13, method: 'preview.stop', params: {} },
			{
				jsonrpc: '2.0',
				id: 14,
				method: 'event.emit',
				params: {
					event: {
						version: 1,
						source: 'codex',
						sessionId: 'session-1',
						state: 'working',
						phase: 'enter',
					},
				},
			},
			{
				jsonrpc: '2.0',
				id: 15,
				method: 'event.clear',
				params: { source: 'codex', sessionId: 'session-1' },
			},
		];

		for (const request of requests) expect(Value.Check(RpcRequestSchema, request)).toBe(true);
	});

	it('rejects unknown methods and fields', () => {
		expect(
			Value.Check(RpcRequestSchema, {
				jsonrpc: '2.0',
				id: 1,
				method: 'device.config.remove',
				params: {},
			}),
		).toBe(false);
		expect(
			Value.Check(RpcRequestSchema, {
				jsonrpc: '2.0',
				id: 1,
				method: 'daemon.getStatus',
				params: {},
				extra: true,
			}),
		).toBe(false);
	});
});

const staticProfile = {
	color: '#402060',
	effect: 'static',
	hardwareIntensity: 0.2,
	intensity: 0.25,
} as const;
const validConfig = {
	version: 1,
	daemon: { frameRate: 10, staleSessionTimeoutMs: 300_000 },
	rendering: { colorSpace: 'linear-rgb', restoreOnExit: true, transitionMs: 300 },
	profiles: {
		working: staticProfile,
		tool_use: staticProfile,
		waiting_permission: staticProfile,
		success: staticProfile,
		error: staticProfile,
		paused: staticProfile,
	},
	devices: {},
} as const;
