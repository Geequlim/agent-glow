import { Command, CommanderError, Option } from 'commander';

import type { RpcRequestFunction } from './rpc-client.js';

export interface CliOutput {
	writeError(message: string): void;
	writeOutput(message: string): void;
}

export async function runCli(
	args: readonly string[],
	version: string,
	output: CliOutput,
	request: RpcRequestFunction,
): Promise<number> {
	const program = new Command()
		.name('agent-glow')
		.description('AgentGlow CLI')
		.version(version)
		.exitOverride()
		.showHelpAfterError()
		.configureOutput({
			writeErr: output.writeError,
			writeOut: output.writeOutput,
		});

	program
		.command('status')
		.description('Show daemon state')
		.action(async () => writeState(output, await request('daemon.getStatus', {})));

	program
		.command('devices')
		.description('List discovered devices')
		.action(async () => {
			output.writeOutput(`${JSON.stringify(await request('device.list', {}), null, 2)}\n`);
		});

	program
		.command('event')
		.description('Submit a semantic state event')
		.requiredOption('--source <source>')
		.requiredOption('--session <session-id>')
		.addOption(
			new Option('--state <state>')
				.choices(['idle', 'working', 'waiting_permission', 'success', 'error', 'paused'])
				.makeOptionMandatory(),
		)
		.addOption(
			new Option('--phase <phase>')
				.choices(['enter', 'leave', 'pulse'])
				.makeOptionMandatory(),
		)
		.action(
			async (options: {
				readonly phase: string;
				readonly session: string;
				readonly source: string;
				readonly state: string;
			}) => {
				writeState(
					output,
					await request('event.emit', {
						event: {
							version: 1,
							source: options.source,
							sessionId: options.session,
							state: options.state,
							phase: options.phase,
						},
					}),
				);
			},
		);

	program
		.command('clear')
		.description('Clear one session')
		.requiredOption('--source <source>')
		.requiredOption('--session <session-id>')
		.addOption(
			new Option('--state <state>').choices([
				'idle',
				'working',
				'waiting_permission',
				'success',
				'error',
				'paused',
			]),
		)
		.action(
			async (options: {
				readonly session: string;
				readonly source: string;
				readonly state?: string;
			}) => {
				writeState(
					output,
					await request('event.clear', {
						source: options.source,
						sessionId: options.session,
						...(options.state ? { state: options.state } : {}),
					}),
				);
			},
		);

	if (args.length === 0) {
		program.outputHelp();
		return 0;
	}

	try {
		await program.parseAsync([...args], { from: 'user' });
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode;
		output.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	return 0;
}

function writeState(output: CliOutput, result: unknown): void {
	if (
		!result ||
		typeof result !== 'object' ||
		!('currentState' in result) ||
		typeof result.currentState !== 'string'
	) {
		throw new Error('Daemon response does not contain currentState');
	}
	output.writeOutput(`${result.currentState}\n`);
}
