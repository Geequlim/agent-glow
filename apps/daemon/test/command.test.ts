import { describe, expect, it } from 'vitest';

import { runDaemonCli } from '../src/command.js';

describe('runDaemonCli', () => {
	it('runs the daemon when no arguments are provided', () => {
		const output = createOutput();
		let starts = 0;

		expect(runDaemonCli([], '1.2.3', output, () => (starts += 1))).toBe(0);
		expect(starts).toBe(1);
		expect(output.stdout).toEqual([]);
		expect(output.stderr).toEqual([]);
	});

	it('prints the supplied version without starting the daemon', () => {
		const output = createOutput();
		let starts = 0;

		expect(runDaemonCli(['--version'], '1.2.3', output, () => (starts += 1))).toBe(0);
		expect(output.stdout).toEqual(['1.2.3\n']);
		expect(starts).toBe(0);
	});

	it('rejects unsupported options without starting the daemon', () => {
		const output = createOutput();
		let starts = 0;

		expect(
			runDaemonCli(['--socket', '/tmp/example.sock'], '1.2.3', output, () => (starts += 1)),
		).toBe(1);
		expect(output.stderr.join('')).toContain("error: unknown option '--socket'");
		expect(output.stderr.join('')).toContain('Usage: agent-glow-daemon [options]');
		expect(starts).toBe(0);
	});
});

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
