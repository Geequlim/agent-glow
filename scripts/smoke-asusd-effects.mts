import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CLI_BUNDLE = path.resolve('apps/cli/dist/index.cjs');
const DAEMON_BUNDLE = path.resolve('apps/daemon/dist/index.cjs');
const CONFIRMATION_ARGUMENT = '--confirm-write';
const DISPLAY_MILLISECONDS = 5000;
const HARDWARE_TEST_ENVIRONMENT = 'AGENT_GLOW_HARDWARE_TEST';
const deviceKind = readDeviceKind();
const states = [
	{ state: 'idle', aura: '低亮度紫色', slash: 'Phantom 亮度 20%' },
	{ state: 'paused', aura: '低亮度暖白', slash: 'Bounce 亮度 30%' },
	{ state: 'working', aura: '蓝紫慢呼吸', slash: 'Loading 亮度 70%' },
	{
		state: 'waiting_permission',
		aura: '琥珀快呼吸',
		slash: 'Buzzer 亮度 100%',
	},
	{ state: 'success', aura: '绿色单脉冲', slash: 'Slash 亮度 90%' },
	{ state: 'error', aura: '红色双脉冲', slash: 'Hazard 亮度 100%' },
] as const;

const confirmed =
	process.env[HARDWARE_TEST_ENVIRONMENT] === '1' && process.argv.includes(CONFIRMATION_ARGUMENT);

if (!confirmed) {
	console.log('[hardware-smoke] dry-run; no hardware will be changed.');
	console.log(`[hardware-smoke] device: ${deviceKind}`);
	console.log(`[hardware-smoke] states: ${states.map(({ state }) => state).join(' → ')}`);
	console.log(
		`[hardware-smoke] set ${HARDWARE_TEST_ENVIRONMENT}=1 and pass ${CONFIRMATION_ARGUMENT} to execute.`,
	);
} else {
	await runHardwareSmoke();
}

async function runHardwareSmoke(): Promise<void> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-glow-effects-'));
	const socketPath = path.join(temporaryDirectory, 'runtime', 'daemon.sock');
	const environment = {
		...process.env,
		AGENT_GLOW_BACKEND: 'asusd',
		AGENT_GLOW_ASUSD_DEVICE_KIND: deviceKind,
		AGENT_GLOW_HARDWARE_TEST: '1',
		AGENT_GLOW_SOCKET: socketPath,
	};
	const daemon = spawn(process.execPath, [DAEMON_BUNDLE], {
		env: environment,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let daemonOutput = '';
	let interrupted = false;

	daemon.stdout.setEncoding('utf8');
	daemon.stderr.setEncoding('utf8');
	daemon.stdout.on('data', (chunk: string) => {
		daemonOutput += chunk;
		process.stdout.write(chunk);
	});
	daemon.stderr.on('data', (chunk: string) => process.stderr.write(chunk));

	const interrupt = (): void => {
		interrupted = true;
		if (daemon.exitCode === null) daemon.kill('SIGTERM');
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', interrupt);

	try {
		await waitForSocket(socketPath, daemon);
		await showInitialIdle(environment);

		for (const effect of states.slice(1)) {
			if (interrupted) throw new Error('Hardware smoke interrupted');
			await showState(environment, effect.state, effect[deviceKind]);
			await delay(DISPLAY_MILLISECONDS);
			await runCli(environment, [
				'clear',
				'--source',
				'hardware-smoke',
				'--session',
				'visual',
			]);
		}

		console.log('[hardware-smoke] all states displayed; stopping daemon to restore snapshot.');
		daemon.kill('SIGTERM');
		const exitCode = await waitForClose(daemon);
		if (exitCode !== 0) throw new Error(`Daemon exited with code ${String(exitCode)}`);
		if (!daemonOutput.includes('restored snapshots backend=asusd')) {
			throw new Error('Daemon did not confirm snapshot restoration');
		}
		console.log('[hardware-smoke] completed; startup lighting state restored.');
	} finally {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', interrupt);
		if (daemon.exitCode === null) {
			daemon.kill('SIGTERM');
			await waitForClose(daemon).catch(() => daemon.kill('SIGKILL'));
		}
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function showInitialIdle(environment: NodeJS.ProcessEnv): Promise<void> {
	const current = await runCli(environment, ['status']);
	if (current !== 'idle') throw new Error(`Expected idle, received ${current}`);
	console.log(
		`[hardware-smoke] displaying state=idle description=${states[0][deviceKind]} holdMs=${DISPLAY_MILLISECONDS}`,
	);
	await delay(DISPLAY_MILLISECONDS);
}

function readDeviceKind(): 'aura' | 'slash' {
	const argument = process.argv.find((value) => value.startsWith('--device='));
	const value = argument?.slice('--device='.length) ?? 'aura';
	if (value !== 'aura' && value !== 'slash') {
		throw new Error(`Unknown hardware smoke device: ${value}`);
	}
	return value;
}

async function showState(
	environment: NodeJS.ProcessEnv,
	state: (typeof states)[number]['state'],
	description: string,
): Promise<void> {
	const current = await runCli(environment, [
		'event',
		'--source',
		'hardware-smoke',
		'--session',
		'visual',
		'--state',
		state,
		'--phase',
		'enter',
	]);
	if (current !== state) throw new Error(`Expected ${state}, received ${current}`);
	console.log(
		`[hardware-smoke] displaying state=${state} description=${description} holdMs=${DISPLAY_MILLISECONDS}`,
	);
}

function runCli(environment: NodeJS.ProcessEnv, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_BUNDLE, ...args], {
			env: environment,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => (stdout += chunk));
		child.stderr.on('data', (chunk: string) => (stderr += chunk));
		child.once('error', reject);
		child.once('close', (code) => {
			if (code === 0) resolve(stdout.trim());
			else reject(new Error(`CLI ${args[0] ?? ''} failed: ${stderr.trim()}`));
		});
	});
}

async function waitForSocket(socketPath: string, daemon: ChildProcess): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (daemon.exitCode !== null)
			throw new Error(`Daemon exited before startup: ${daemon.exitCode}`);
		const socket = await lstat(socketPath).catch(() => undefined);
		if (socket?.isSocket()) return;
		await delay(50);
	}
	throw new Error('Timed out waiting for daemon socket');
}

function waitForClose(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
}
