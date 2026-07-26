import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI_BUNDLE = path.resolve('apps/cli/dist/index.cjs');
const DAEMON_BUNDLE = path.resolve('apps/daemon/dist/index.cjs');
const EXPECTED_VERSION = '0.0.0';
const TIMEOUT_MILLISECONDS = 5000;

await assertVersion(CLI_BUNDLE);
await assertVersion(DAEMON_BUNDLE);
await assertMvpClosure();

console.log('Built CLI → daemon → fake backend smoke tests passed.');

async function assertVersion(bundle: string): Promise<void> {
	const result = await runProcess(bundle, ['--version']);
	if (result.code !== 0 || result.stdout.trim() !== EXPECTED_VERSION) {
		throw new Error(
			`${bundle} version smoke failed: code=${String(result.code)} stdout=${JSON.stringify(
				result.stdout,
			)} stderr=${JSON.stringify(result.stderr)}`,
		);
	}
}

async function assertMvpClosure(): Promise<void> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-glow-smoke-'));
	const socketPath = path.join(temporaryDirectory, 'runtime', 'daemon.sock');
	const environment = { ...process.env, AGENT_GLOW_SOCKET: socketPath };
	const child = spawn(process.execPath, [DAEMON_BUNDLE], {
		env: environment,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	let started = false;

	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
		if (stdout.includes('daemon started at')) started = true;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});

	try {
		await waitFor(() => started, 'daemon startup');
		await assertSocketPermissions(socketPath);
		await assertCli(environment, ['status'], 'idle');
		await assertCli(
			environment,
			[
				'event',
				'--source',
				'smoke',
				'--session',
				'session-1',
				'--state',
				'working',
				'--phase',
				'enter',
			],
			'working',
		);
		await assertCli(environment, ['status'], 'working');

		const devices = await runProcess(CLI_BUNDLE, ['devices'], environment);
		if (devices.code !== 0 || !devices.stdout.includes('fake:light-1')) {
			throw new Error(`Device smoke failed: ${JSON.stringify(devices)}`);
		}

		await assertCli(
			environment,
			['clear', '--source', 'smoke', '--session', 'session-1'],
			'idle',
		);
		await assertCli(environment, ['status'], 'idle');

		child.kill('SIGTERM');
		const code = await waitForClose(child);

		if (code !== 0 || !stdout.includes('received SIGTERM, stopping') || stderr.length > 0) {
			throw new Error(
				`Daemon shutdown smoke failed: code=${String(code)} stdout=${JSON.stringify(
					stdout,
				)} stderr=${JSON.stringify(stderr)}`,
			);
		}
	} finally {
		if (child.exitCode === null) child.kill('SIGKILL');
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function runProcess(
	bundle: string,
	args: readonly string[],
	environment: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [bundle, ...args], {
			env: environment,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MILLISECONDS);

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.once('error', reject);
		child.once('close', (code) => {
			clearTimeout(timeout);
			resolve({ code, stdout, stderr });
		});
	});
}

async function assertCli(
	environment: NodeJS.ProcessEnv,
	args: readonly string[],
	expectedOutput: string,
): Promise<void> {
	const result = await runProcess(CLI_BUNDLE, args, environment);
	if (result.code !== 0 || result.stdout.trim() !== expectedOutput || result.stderr.length > 0) {
		throw new Error(
			`CLI smoke failed for ${args[0] ?? ''}: code=${String(result.code)} stdout=${JSON.stringify(
				result.stdout,
			)} stderr=${JSON.stringify(result.stderr)}`,
		);
	}
}

async function assertSocketPermissions(socketPath: string): Promise<void> {
	const directoryMode = (await stat(path.dirname(socketPath))).mode & 0o777;
	const socketMode = (await stat(socketPath)).mode & 0o777;
	if (directoryMode !== 0o700 || socketMode !== 0o600) {
		throw new Error(
			`Unsafe socket permissions: directory=${directoryMode.toString(8)} socket=${socketMode.toString(8)}`,
		);
	}
}

function waitFor(predicate: () => boolean, description: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const interval = setInterval(() => {
			if (predicate()) {
				clearInterval(interval);
				resolve();
			} else if (Date.now() - startedAt >= TIMEOUT_MILLISECONDS) {
				clearInterval(interval);
				reject(new Error(`Timed out waiting for ${description}`));
			}
		}, 10);
	});
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('Timed out waiting for daemon shutdown'));
		}, TIMEOUT_MILLISECONDS);
		child.once('error', reject);
		child.once('close', (code) => {
			clearTimeout(timeout);
			resolve(code);
		});
	});
}
