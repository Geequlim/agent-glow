import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { parseConfigYaml, stringifyConfigYaml, validateConfigValue } from '@agent-glow/config';
import { Command, CommanderError, Option } from 'commander';

import type { RpcRequestFunction } from './rpc-client.js';

export interface CliOutput {
	writeError(message: string): void;
	writeOutput(message: string): void;
}

export interface ServiceCommandResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

export type ServiceCommandRunner = (
	command: string,
	args: readonly string[],
) => Promise<ServiceCommandResult>;

export async function runCli(
	args: readonly string[],
	version: string,
	output: CliOutput,
	request: RpcRequestFunction,
	readTextFile: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, 'utf8'),
	runServiceCommand: ServiceCommandRunner = spawnServiceCommand,
	readStdin: () => Promise<string> = readStandardInput,
): Promise<number> {
	let commandExitCode = 0;
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

	const serviceCommand = program
		.command('service')
		.description('Manage the systemd user service');
	for (const action of ['status', 'start', 'stop', 'restart', 'enable', 'disable'] as const) {
		serviceCommand
			.command(action)
			.description(`${action} agent-glow.service`)
			.action(async () => {
				const result = await runServiceCommand('systemctl', [
					'--user',
					action,
					'agent-glow.service',
				]);
				if (result.stdout) output.writeOutput(result.stdout);
				if (result.stderr) output.writeError(result.stderr);
				commandExitCode = result.exitCode;
			});
	}

	const configCommand = program.command('config').description('Manage daemon configuration');
	configCommand
		.command('show')
		.description('Show the active configuration as YAML')
		.action(async () => {
			const config = validateConfigValue(await request('config.get', {}));
			output.writeOutput(stringifyConfigYaml(config));
		});
	configCommand
		.command('validate')
		.description('Validate a YAML configuration with the daemon')
		.argument('<file>')
		.action(async (filePath: string) => {
			const config = parseConfigYaml(await readTextFile(filePath));
			await request('config.validate', { config });
			output.writeOutput('valid\n');
		});
	configCommand
		.command('apply')
		.description('Validate and apply a YAML configuration')
		.argument('<file>')
		.action(async (filePath: string) => {
			const config = parseConfigYaml(await readTextFile(filePath));
			const updated = validateConfigValue(await request('config.update', { config }));
			output.writeOutput(stringifyConfigYaml(updated));
		});

	program
		.command('device-config')
		.description('Show configuration registered by a device')
		.argument('<device-id>')
		.action(async (deviceId: string) => {
			output.writeOutput(
				`${JSON.stringify(await request('device.config.get', { deviceId }), null, 2)}\n`,
			);
		});

	program
		.command('device-config-set')
		.description('Update one runtime device configuration value')
		.argument('<device-id>')
		.argument('<key>')
		.argument('<value>')
		.action(async (deviceId: string, key: string, value: string) => {
			output.writeOutput(
				`${JSON.stringify(
					await request('device.config.update', {
						deviceId,
						values: { [key]: parseConfigurationValue(value) },
					}),
					null,
					2,
				)}\n`,
			);
		});

	program
		.command('diagnostics')
		.description('Show backend and device apply diagnostics')
		.action(async () => {
			output.writeOutput(
				`${JSON.stringify(await request('diagnostics.get', {}), null, 2)}\n`,
			);
		});

	program
		.command('adapt')
		.description('Adapt an Agent lifecycle hook from stdin')
		.argument('<agent>', 'Agent adapter')
		.action(async (agent: string) => {
			if (agent !== 'codex' && agent !== 'zcode')
				throw new Error(`Unsupported Agent adapter: ${agent}`);
			await adaptLifecycleHook(await readStdin(), agent, request);
		});

	program
		.command('event')
		.description('Submit a semantic state event')
		.requiredOption('--source <source>')
		.requiredOption('--session <session-id>')
		.addOption(
			new Option('--state <state>')
				.choices([
					'idle',
					'working',
					'tool_use',
					'waiting_permission',
					'success',
					'error',
					'paused',
				])
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
				'tool_use',
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

	return commandExitCode;
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

function parseConfigurationValue(value: string): string | number | boolean {
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (/^-?\d+$/u.test(value)) return Number(value);
	return value;
}

export async function adaptCodexHook(source: string, request: RpcRequestFunction): Promise<void> {
	return adaptLifecycleHook(source, 'codex', request);
}

export async function adaptLifecycleHook(
	source: string,
	agent: 'codex' | 'zcode',
	request: RpcRequestFunction,
): Promise<void> {
	let payload: unknown;
	try {
		payload = JSON.parse(source);
	} catch {
		return;
	}
	if (
		!payload ||
		typeof payload !== 'object' ||
		!('hook_event_name' in payload) ||
		typeof payload.hook_event_name !== 'string' ||
		!('session_id' in payload) ||
		typeof payload.session_id !== 'string' ||
		!payload.session_id
	) {
		return;
	}
	const sessionId = payload.session_id;
	const emit = (
		state: 'working' | 'tool_use' | 'waiting_permission' | 'success' | 'error',
		phase: 'enter' | 'pulse',
		ttlMs?: number,
	): Promise<unknown> =>
		request('event.emit', {
			event: {
				version: 1,
				source: agent,
				sessionId,
				state,
				phase,
				...(ttlMs ? { ttlMs } : {}),
			},
		});
	const clear = (state?: string): Promise<unknown> =>
		request('event.clear', {
			source: agent,
			sessionId,
			...(state ? { state } : {}),
		});
	const transition = (
		clearStates: readonly string[],
		event?: {
			readonly state: 'tool_use' | 'success' | 'error';
			readonly phase: 'enter' | 'pulse';
			readonly ttlMs?: number;
		},
	): Promise<unknown> =>
		request('event.transition', {
			source: agent,
			sessionId,
			clearStates,
			...(event ? { event } : {}),
		});
	try {
		switch (payload.hook_event_name) {
			case 'UserPromptSubmit':
				await emit('working', 'enter');
				break;
			case 'PermissionRequest':
				await emit('waiting_permission', 'pulse', 20_000);
				break;
			case 'PreToolUse':
				await transition(['waiting_permission'], {
					state: 'tool_use',
					phase: 'enter',
				});
				break;
			case 'PostToolUse':
				await transition(['waiting_permission', 'tool_use']);
				break;
			case 'PostToolUseFailure':
				await transition(['waiting_permission', 'tool_use'], {
					state: 'error',
					phase: 'pulse',
				});
				break;
			case 'Stop':
				await transition(['waiting_permission', 'tool_use', 'working'], {
					state: 'success',
					phase: 'pulse',
				});
				break;
			case 'SessionEnd':
			case 'SessionStart':
				await clear();
				break;
		}
	} catch {
		// Hook integrations must never block the Agent when the daemon is unavailable.
	}
}

async function readStandardInput(): Promise<string> {
	let source = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) source += chunk;
	return source;
}

function spawnServiceCommand(
	command: string,
	args: readonly string[],
): Promise<ServiceCommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		let stdout = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.once('error', reject);
		child.once('close', (exitCode) => {
			resolve({ exitCode: exitCode ?? 1, stderr, stdout });
		});
	});
}
