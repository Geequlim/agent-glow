import { describe, expect, it } from 'vitest';

import { runCli } from '../src/command.js';

describe('runCli', () => {
	it('prints help when invoked without arguments', async () => {
		const output = createOutput();

		expect(await runCli([], '1.2.3', output, unusedRequest)).toBe(0);
		expect(output.stdout.join('')).toContain('AgentGlow CLI');
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
