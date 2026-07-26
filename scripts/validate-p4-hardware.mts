import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CLI_BUNDLE = path.resolve('apps/cli/dist/index.cjs');
const DAEMON_BUNDLE = path.resolve('apps/daemon/dist/index.cjs');
const CONFIRMATION_ARGUMENT = '--confirm-write';
const DEFAULT_ENDURANCE_MILLISECONDS = 10 * 60 * 1000;
const DIAGNOSTIC_INTERVAL_MILLISECONDS = 30_000;
const RESTART_TIMEOUT_MILLISECONDS = 3 * 60 * 1000;
const enduranceMilliseconds = readDuration();
const waitForRestart = process.argv.includes('--wait-for-restart');
const confirmed =
	process.env.AGENT_GLOW_HARDWARE_TEST === '1' && process.argv.includes(CONFIRMATION_ARGUMENT);

if (!confirmed) {
	console.log('[p4-hardware] dry-run; no hardware will be changed.');
	console.log(`[p4-hardware] Aura enduranceMs=${enduranceMilliseconds}`);
	console.log(
		'[p4-hardware] tests: endurance → rapid redirect → semantic sequence → two sessions',
	);
	console.log(`[p4-hardware] restart check: ${waitForRestart ? 'enabled' : 'disabled'}`);
	console.log(
		'[p4-hardware] set AGENT_GLOW_HARDWARE_TEST=1 and pass --confirm-write to execute.',
	);
} else {
	await runValidation();
}

async function runValidation(): Promise<void> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-glow-p4-'));
	const socketPath = path.join(temporaryDirectory, 'runtime', 'daemon.sock');
	const environment = {
		...process.env,
		AGENT_GLOW_BACKEND: 'asusd',
		AGENT_GLOW_ASUSD_DEVICE_KIND: 'aura',
		AGENT_GLOW_HARDWARE_TEST: '1',
		AGENT_GLOW_SOCKET: socketPath,
		XDG_CONFIG_HOME: path.join(temporaryDirectory, 'config'),
	};
	const daemon = spawn(process.execPath, [DAEMON_BUNDLE], {
		env: environment,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let daemonLog = '';
	let interrupted = false;

	const appendLog = (chunk: string, stream: NodeJS.WriteStream): void => {
		daemonLog += chunk;
		stream.write(chunk);
	};
	daemon.stdout.setEncoding('utf8');
	daemon.stderr.setEncoding('utf8');
	daemon.stdout.on('data', (chunk: string) => appendLog(chunk, process.stdout));
	daemon.stderr.on('data', (chunk: string) => appendLog(chunk, process.stderr));

	const interrupt = (): void => {
		interrupted = true;
		if (daemon.exitCode === null) daemon.kill('SIGTERM');
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', interrupt);

	try {
		await waitForSocket(socketPath, daemon);
		await assertState(environment, 'idle');
		await runEndurance(environment, daemon, () => interrupted);
		await runRapidRedirect(environment);
		await runSemanticSequence(environment);
		await runTwoSessionArbitration(environment);
		if (waitForRestart) await runRestartCheck(environment, () => daemonLog);
		assertCleanDaemonLog(daemonLog, waitForRestart);

		console.log('[p4-hardware] automated P4-E checks passed; stopping daemon.');
		daemon.kill('SIGTERM');
		const exitCode = await waitForClose(daemon);
		if (exitCode !== 0) throw new Error(`Daemon exited with code ${String(exitCode)}`);
		if (!daemonLog.includes('restored snapshots backend=asusd')) {
			throw new Error('Daemon did not confirm snapshot restoration');
		}
		console.log('[p4-hardware] startup Aura state restored and verified.');
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

async function runEndurance(
	environment: NodeJS.ProcessEnv,
	daemon: ChildProcess,
	isInterrupted: () => boolean,
): Promise<void> {
	if (enduranceMilliseconds === 0) return;
	await emit(environment, 'p4-endurance', 'working', 'enter');
	console.log(
		`[p4-hardware] Aura working breathe endurance started durationMs=${enduranceMilliseconds}`,
	);
	const startedAt = performance.now();
	let samples = 0;
	while (performance.now() - startedAt < enduranceMilliseconds) {
		if (isInterrupted()) throw new Error('P4 hardware validation interrupted');
		if (daemon.exitCode !== null) {
			throw new Error(`Daemon exited during endurance: ${String(daemon.exitCode)}`);
		}
		const remaining = enduranceMilliseconds - (performance.now() - startedAt);
		await delay(Math.min(DIAGNOSTIC_INTERVAL_MILLISECONDS, remaining));
		await emit(environment, 'p4-endurance', 'working', 'enter');
		await assertState(environment, 'working');
		const diagnostic = await readHealthyDiagnostic(environment);
		samples += 1;
		console.log(
			`[p4-hardware] endurance sample=${samples} elapsedMs=${Math.round(
				performance.now() - startedAt,
			)} active=${diagnostic.active} pending=${diagnostic.pending}`,
		);
	}
	await clear(environment, 'p4-endurance');
	await assertState(environment, 'idle');
	console.log(`[p4-hardware] endurance passed samples=${samples}`);
}

async function runRapidRedirect(environment: NodeJS.ProcessEnv): Promise<void> {
	console.log('[p4-hardware] rapid redirect started intervalMs=75');
	await emit(environment, 'p4-rapid-base', 'working', 'enter');
	await delay(75);
	await emit(environment, 'p4-rapid-permission', 'waiting_permission', 'enter');
	await delay(75);
	await emit(environment, 'p4-rapid-permission', 'waiting_permission', 'leave');
	await delay(75);
	await emit(environment, 'p4-rapid-signal', 'error', 'pulse');
	await delay(75);
	await clear(environment, 'p4-rapid-signal');
	await clear(environment, 'p4-rapid-base');
	await assertState(environment, 'idle');
	await readHealthyDiagnostic(environment);
	console.log('[p4-hardware] rapid redirect passed');
}

async function runSemanticSequence(environment: NodeJS.ProcessEnv): Promise<void> {
	console.log(
		'[p4-hardware] sequence: working → waiting_permission → working → success → working → idle',
	);
	await emit(environment, 'p4-sequence-base', 'working', 'enter');
	await assertState(environment, 'working');
	await delay(500);
	await emit(environment, 'p4-sequence-permission', 'waiting_permission', 'enter');
	await assertState(environment, 'waiting_permission');
	await delay(500);
	await emit(environment, 'p4-sequence-permission', 'waiting_permission', 'leave');
	await assertState(environment, 'working');
	await delay(500);
	await emit(environment, 'p4-sequence-signal', 'success', 'pulse');
	await assertState(environment, 'success');
	await delay(1700);
	await assertState(environment, 'working');
	await clear(environment, 'p4-sequence-base');
	await assertState(environment, 'idle');
	await readHealthyDiagnostic(environment);
	console.log('[p4-hardware] semantic sequence passed');
}

async function runTwoSessionArbitration(environment: NodeJS.ProcessEnv): Promise<void> {
	console.log('[p4-hardware] two-session arbitration started');
	await emit(environment, 'p4-session-a', 'working', 'enter');
	await emit(environment, 'p4-session-b', 'waiting_permission', 'enter');
	await assertState(environment, 'waiting_permission');
	await clear(environment, 'p4-session-b');
	await assertState(environment, 'working');
	await clear(environment, 'p4-session-a');
	await assertState(environment, 'idle');
	console.log('[p4-hardware] two-session arbitration passed');
}

async function runRestartCheck(
	environment: NodeJS.ProcessEnv,
	readDaemonLog: () => string,
): Promise<void> {
	await emit(environment, 'p4-restart', 'working', 'enter');
	console.log('[p4-hardware] restart window ready.');
	console.log('[p4-hardware] restart the installed asusd service from another terminal now.');
	const startedAt = performance.now();
	while (performance.now() - startedAt < RESTART_TIMEOUT_MILLISECONDS) {
		const log = readDaemonLog();
		if (
			log.includes('backend unavailable backend=asusd') &&
			log.includes('reason=service-restored')
		) {
			await assertState(environment, 'working');
			await readHealthyDiagnostic(environment);
			await clear(environment, 'p4-restart');
			await assertState(environment, 'idle');
			console.log('[p4-hardware] asusd restart recovery passed');
			return;
		}
		await delay(250);
	}
	throw new Error('Timed out waiting for asusd restart recovery');
}

async function readHealthyDiagnostic(
	environment: NodeJS.ProcessEnv,
): Promise<{ readonly active: boolean; readonly pending: boolean }> {
	const output = await runCli(environment, ['diagnostics']);
	const diagnostic = JSON.parse(output) as {
		readonly backend?: { readonly health?: string };
		readonly devices?: Array<{
			readonly delivery?: {
				readonly active?: boolean;
				readonly consecutiveFailures?: number;
				readonly pending?: boolean;
				readonly retryScheduled?: boolean;
			};
			readonly status?: string;
		}>;
	};
	const device = diagnostic.devices?.[0];
	const delivery = device?.delivery;
	if (
		diagnostic.backend?.health !== 'healthy' ||
		device?.status !== 'ok' ||
		!delivery ||
		delivery.consecutiveFailures !== 0 ||
		delivery.retryScheduled !== false ||
		typeof delivery.active !== 'boolean' ||
		typeof delivery.pending !== 'boolean'
	) {
		throw new Error(`Unhealthy P4 diagnostic: ${output}`);
	}
	return { active: delivery.active, pending: delivery.pending };
}

async function emit(
	environment: NodeJS.ProcessEnv,
	session: string,
	state: string,
	phase: 'enter' | 'leave' | 'pulse',
): Promise<void> {
	await runCli(environment, [
		'event',
		'--source',
		'p4-hardware',
		'--session',
		session,
		'--state',
		state,
		'--phase',
		phase,
	]);
}

async function clear(environment: NodeJS.ProcessEnv, session: string): Promise<void> {
	await runCli(environment, ['clear', '--source', 'p4-hardware', '--session', session]);
}

async function assertState(environment: NodeJS.ProcessEnv, expected: string): Promise<void> {
	const current = await runCli(environment, ['status']);
	if (current !== expected) throw new Error(`Expected ${expected}, received ${current}`);
}

function assertCleanDaemonLog(log: string, restartExpected: boolean): void {
	for (const failure of [
		'safe fallback failed',
		'backend lifecycle handling failed',
		'D-Bus request timed out',
	]) {
		if (log.includes(failure)) throw new Error(`Daemon logged a failure: ${failure}`);
	}
	if (!restartExpected && log.includes('device apply failed')) {
		throw new Error('Daemon logged a device apply failure');
	}
	if (restartExpected && log.includes('failures=2')) {
		throw new Error('Device remained unavailable after the first restart failure');
	}
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
		if (daemon.exitCode !== null) {
			throw new Error(`Daemon exited before startup: ${String(daemon.exitCode)}`);
		}
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

function readDuration(): number {
	const argument = process.argv.find((value) => value.startsWith('--duration-ms='));
	if (!argument) return DEFAULT_ENDURANCE_MILLISECONDS;
	const value = Number(argument.slice('--duration-ms='.length));
	if (!Number.isInteger(value) || value < 0) throw new Error('Invalid --duration-ms value');
	return value;
}
