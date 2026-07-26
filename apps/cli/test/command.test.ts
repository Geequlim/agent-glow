import { describe, expect, it } from 'vitest';

import { createDefaultConfig, stringifyConfigYaml } from '@agent-glow/config';

import { adaptCodexHook, adaptLifecycleHook, runCli } from '../src/command.js';

describe('runCli', () => {
	it('prints help when invoked without arguments', async () => {
		const output = createOutput();

		expect(await runCli([], '1.2.3', output, unusedRequest)).toBe(0);
		expect(output.stdout.join('')).toContain('Agent Glow CLI');
		expect(output.stderr).toEqual([]);
	});

	it('prints the supplied version', async () => {
		const output = createOutput();

		expect(await runCli(['--version'], '1.2.3', output, unusedRequest)).toBe(0);
		expect(output.stdout).toEqual(['1.2.3\n']);
	});

	it('prints daemon status', async () => {
		const output = createOutput();

		expect(
			await runCli(['status'], '1.2.3', output, async (method) => {
				expect(method).toBe('daemon.getStatus');
				return { lifecycle: 'running', currentState: 'working' };
			}),
		).toBe(0);
		expect(output.stdout).toEqual(['working\n']);
	});

	it('submits an event through the injected RPC client', async () => {
		const output = createOutput();

		expect(
			await runCli(
				[
					'event',
					'--source',
					'codex',
					'--session',
					'session-1',
					'--state',
					'working',
					'--phase',
					'enter',
				],
				'1.2.3',
				output,
				async (method, params) => {
					expect(method).toBe('event.emit');
					expect(params).toEqual({
						event: {
							version: 1,
							source: 'codex',
							sessionId: 'session-1',
							state: 'working',
							phase: 'enter',
						},
					});
					return { accepted: true, currentState: 'working' };
				},
			),
		).toBe(0);
		expect(output.stdout).toEqual(['working\n']);
	});

	it('updates a typed device configuration value', async () => {
		const output = createOutput();

		expect(
			await runCli(
				['device-config-set', 'future-rgb:light-1', 'states.working.brightness', '200'],
				'1.2.3',
				output,
				async (method, params) => {
					expect(method).toBe('device.config.update');
					expect(params).toEqual({
						deviceId: 'future-rgb:light-1',
						values: { 'states.working.brightness': 200 },
					});
					return { deviceId: 'future-rgb:light-1', settings: [], values: {} };
				},
			),
		).toBe(0);
		expect(output.stderr).toEqual([]);
	});

	it('shows, validates and applies YAML configuration through RPC', async () => {
		const config = createDefaultConfig();
		const source = stringifyConfigYaml(config);
		const showOutput = createOutput();
		expect(
			await runCli(['config', 'show'], '1.2.3', showOutput, async (method, params) => {
				expect([method, params]).toEqual(['config.get', {}]);
				return config;
			}),
		).toBe(0);
		expect(showOutput.stdout.join('')).toBe(source);

		for (const action of ['validate', 'apply'] as const) {
			const output = createOutput();
			expect(
				await runCli(
					['config', action, 'candidate.yaml'],
					'1.2.3',
					output,
					async (method, params) => {
						expect(method).toBe(`config.${action === 'apply' ? 'update' : action}`);
						expect(params).toEqual({ config });
						return action === 'apply' ? config : { valid: true };
					},
					async (filePath) => {
						expect(filePath).toBe('candidate.yaml');
						return source;
					},
				),
			).toBe(0);
			expect(output.stdout.join('')).toBe(action === 'apply' ? source : 'valid\n');
		}
	});

	it('runs every service action through systemctl --user without a shell', async () => {
		for (const action of ['status', 'start', 'stop', 'restart', 'enable', 'disable'] as const) {
			const output = createOutput();
			expect(
				await runCli(
					['service', action],
					'1.2.3',
					output,
					unusedRequest,
					async () => {
						throw new Error('File should not be read');
					},
					async (command, args) => {
						expect(command).toBe('systemctl');
						expect(args).toEqual(['--user', action, 'agent-glow.service']);
						return { exitCode: 0, stderr: '', stdout: `${action}\n` };
					},
				),
			).toBe(0);
			expect(output.stdout).toEqual([`${action}\n`]);
			expect(output.stderr).toEqual([]);
		}
	});

	it('propagates the systemctl exit code and stderr', async () => {
		const output = createOutput();
		expect(
			await runCli(
				['service', 'status'],
				'1.2.3',
				output,
				unusedRequest,
				async () => '',
				async () => ({ exitCode: 3, stderr: 'inactive\n', stdout: '' }),
			),
		).toBe(3);
		expect(output.stderr).toEqual(['inactive\n']);
	});

	it('adapts Codex hook events from stdin without printing hook output', async () => {
		const output = createOutput();
		const calls: unknown[][] = [];

		expect(
			await runCli(
				['adapt', 'codex'],
				'1.2.3',
				output,
				async (method, params) => {
					calls.push([method, params]);
					return { accepted: true, currentState: 'working' };
				},
				undefined,
				undefined,
				async () =>
					JSON.stringify({
						hook_event_name: 'UserPromptSubmit',
						session_id: 'codex-session',
					}),
			),
		).toBe(0);
		expect(calls).toEqual([
			[
				'event.emit',
				{
					event: {
						version: 1,
						source: 'codex',
						sessionId: 'codex-session',
						state: 'working',
						phase: 'enter',
					},
				},
			],
		]);
		expect(output.stdout).toEqual([]);
		expect(output.stderr).toEqual([]);
	});

	it('maps Codex completion and ignores daemon failures so hooks never block Codex', async () => {
		const output = createOutput();
		const calls: string[] = [];

		expect(
			await runCli(
				['adapt', 'codex'],
				'1.2.3',
				output,
				async (method) => {
					calls.push(method);
					throw new Error('daemon unavailable');
				},
				undefined,
				undefined,
				async () =>
					JSON.stringify({ hook_event_name: 'Stop', session_id: 'codex-session' }),
			),
		).toBe(0);
		expect(calls).toEqual(['event.transition']);
		expect(output.stderr).toEqual([]);
	});

	it('ignores malformed Codex hook input', async () => {
		const output = createOutput();
		expect(
			await runCli(
				['adapt', 'codex'],
				'1.2.3',
				output,
				unusedRequest,
				undefined,
				undefined,
				async () => '{broken',
			),
		).toBe(0);
	});

	it.each([
		[
			'PermissionRequest',
			[
				'event.emit',
				{
					event: {
						version: 1,
						source: 'codex',
						sessionId: 'codex-session',
						state: 'waiting_permission',
						phase: 'pulse',
						ttlMs: 20_000,
					},
				},
			],
		],
		[
			'PostToolUse',
			[
				'event.transition',
				{
					source: 'codex',
					sessionId: 'codex-session',
					clearStates: ['waiting_permission', 'tool_use'],
				},
			],
		],
		['SessionEnd', ['event.clear', { source: 'codex', sessionId: 'codex-session' }]],
	] as const)('maps the Codex %s fixture', async (hookEventName, expectedCall) => {
		const calls: unknown[][] = [];
		await adaptCodexHook(
			JSON.stringify({
				hook_event_name: hookEventName,
				session_id: 'codex-session',
			}),
			async (method, params) => {
				calls.push([method, params]);
				return {};
			},
		);
		expect(calls).toEqual([expectedCall]);
	});

	it('maps Codex PreToolUse to tool use after clearing permission', async () => {
		const calls: unknown[][] = [];
		await adaptCodexHook(
			JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'codex-session' }),
			async (method, params) => {
				calls.push([method, params]);
				return {};
			},
		);

		expect(calls).toEqual([
			[
				'event.transition',
				{
					source: 'codex',
					sessionId: 'codex-session',
					clearStates: ['waiting_permission'],
					event: {
						state: 'tool_use',
						phase: 'enter',
					},
				},
			],
		]);
	});

	it('maps the Codex Stop fixture to completion followed by lease cleanup', async () => {
		const calls: unknown[][] = [];
		await adaptCodexHook(
			JSON.stringify({ hook_event_name: 'Stop', session_id: 'codex-session' }),
			async (method, params) => {
				calls.push([method, params]);
				return {};
			},
		);

		expect(calls).toEqual([
			[
				'event.transition',
				{
					source: 'codex',
					sessionId: 'codex-session',
					clearStates: ['waiting_permission', 'tool_use', 'working'],
					event: {
						state: 'success',
						phase: 'pulse',
					},
				},
			],
		]);
	});

	it('adapts ZCode tool failures with an isolated source', async () => {
		const calls: unknown[][] = [];
		await adaptLifecycleHook(
			JSON.stringify({
				hook_event_name: 'PostToolUseFailure',
				session_id: 'zcode-session',
			}),
			'zcode',
			async (method, params) => {
				calls.push([method, params]);
				return {};
			},
		);

		expect(calls).toEqual([
			[
				'event.transition',
				{
					source: 'zcode',
					sessionId: 'zcode-session',
					clearStates: ['waiting_permission', 'tool_use'],
					event: {
						state: 'error',
						phase: 'pulse',
					},
				},
			],
		]);
	});
});

async function unusedRequest(): Promise<never> {
	throw new Error('RPC should not be called');
}

function createOutput(): {
	readonly stderr: string[];
	readonly stdout: string[];
	writeError(message: string): void;
	writeOutput(message: string): void;
} {
	const stderr: string[] = [];
	const stdout: string[] = [];
	return {
		stderr,
		stdout,
		writeError: (message) => stderr.push(message),
		writeOutput: (message) => stdout.push(message),
	};
}
