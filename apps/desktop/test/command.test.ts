import { describe, expect, it, vi } from 'vitest';

import { runDesktopCli } from '../src/command.js';

describe('runDesktopCli', () => {
	it('starts the application when no arguments are supplied', () => {
		const output = createOutput();
		const startApplication = vi.fn(() => 0);

		expect(runDesktopCli([], '1.2.3', output, startApplication)).toBe(0);
		expect(startApplication).toHaveBeenCalledOnce();
		expect(output.stderr).toEqual([]);
	});

	it('prints the supplied version without starting GTK', () => {
		const output = createOutput();
		const startApplication = vi.fn(() => 0);

		expect(runDesktopCli(['--version'], '1.2.3', output, startApplication)).toBe(0);
		expect(output.stdout).toEqual(['1.2.3\n']);
		expect(startApplication).not.toHaveBeenCalled();
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
