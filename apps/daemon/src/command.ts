import { Command, CommanderError } from 'commander';

export interface DaemonCliOutput {
	writeError(message: string): void;
	writeOutput(message: string): void;
}

export function runDaemonCli(
	args: readonly string[],
	version: string,
	output: DaemonCliOutput,
	startDaemon: () => void,
): number {
	const program = new Command()
		.name('agent-glow-daemon')
		.description('AgentGlow daemon')
		.version(version)
		.exitOverride()
		.showHelpAfterError()
		.configureOutput({
			writeErr: output.writeError,
			writeOut: output.writeOutput,
		});

	if (args.length === 0) {
		startDaemon();
		return 0;
	}

	try {
		program.parse([...args], { from: 'user' });
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode;
		throw error;
	}

	return 0;
}
