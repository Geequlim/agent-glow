import { Command, CommanderError } from 'commander';

export interface DesktopCliOutput {
	writeError(message: string): void;
	writeOutput(message: string): void;
}

export function runDesktopCli(
	args: readonly string[],
	version: string,
	output: DesktopCliOutput,
	startApplication: () => number,
): number {
	const program = new Command()
		.name('agent-glow-desktop')
		.description('Agent Glow desktop application')
		.version(version)
		.exitOverride()
		.showHelpAfterError()
		.configureOutput({
			writeErr: output.writeError,
			writeOut: output.writeOutput,
		});

	if (args.length === 0) return startApplication();

	try {
		program.parse([...args], { from: 'user' });
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode;
		throw error;
	}
	return 0;
}
