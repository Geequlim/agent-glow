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
			{ jsonrpc: '2.0', id: 3, method: 'device.list', params: {} },
			{
				jsonrpc: '2.0',
				id: 4,
				method: 'device.config.get',
				params: { deviceId: 'fake:light-1' },
			},
			{
				jsonrpc: '2.0',
				id: 5,
				method: 'device.config.update',
				params: {
					deviceId: 'fake:light-1',
					values: { 'states.working.brightness': 128 },
				},
			},
			{ jsonrpc: '2.0', id: 6, method: 'diagnostics.get', params: {} },
			{
				jsonrpc: '2.0',
				id: 7,
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
				id: 8,
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
