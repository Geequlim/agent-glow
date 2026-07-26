import { spawn } from 'node:child_process';

const SERVICE_NAME = 'agent-glow.service';

export interface ServiceStatus {
	readonly enabled: boolean;
	readonly running: boolean;
}

export interface ServiceClient {
	getStatus(): Promise<ServiceStatus>;
	setEnabled(enabled: boolean): Promise<void>;
}

interface CommandResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export class SystemdServiceClient implements ServiceClient {
	readonly #run: CommandRunner;

	constructor(run: CommandRunner = runCommand) {
		this.#run = run;
	}

	async getStatus(): Promise<ServiceStatus> {
		const output = await this.#systemctl([
			'show',
			SERVICE_NAME,
			'--property=ActiveState',
			'--property=UnitFileState',
		]);
		const properties = new Map(
			output
				.trim()
				.split('\n')
				.map((line) => {
					const index = line.indexOf('=');
					return [line.slice(0, index), line.slice(index + 1)] as const;
				}),
		);
		return {
			running: properties.get('ActiveState') === 'active',
			enabled: properties.get('UnitFileState') === 'enabled',
		};
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await this.#systemctl([enabled ? 'enable' : 'disable', '--now', SERVICE_NAME]);
	}

	async #systemctl(args: readonly string[]): Promise<string> {
		const result = await this.#run('systemctl', ['--user', ...args]);
		if (result.exitCode === 0) return result.stdout;
		throw new Error(result.stderr.trim() || result.stdout.trim() || 'systemctl 操作失败。');
	}
}

function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.once('error', reject);
		child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stderr, stdout }));
	});
}
