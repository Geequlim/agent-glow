import { spawn } from 'node:child_process';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const action = process.argv[2];
if (action !== 'install' && action !== 'remove') {
	console.error('Usage: node scripts/manage-dev-service.mts <install|remove>');
	process.exitCode = 2;
} else {
	await manageDevelopmentService(action);
}

async function manageDevelopmentService(action: 'install' | 'remove'): Promise<void> {
	const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const daemonBundle = path.join(repositoryRoot, 'apps', 'daemon', 'dist', 'index.cjs');
	const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
	const unitDirectory = path.join(configHome, 'systemd', 'user');
	const unitPath = path.join(unitDirectory, 'agent-glow.service');

	if (action === 'install') {
		await access(daemonBundle);
		await runSystemctl(['unmask', 'agent-glow.service']);
		await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${unitPath}.tmp-${process.pid}`;
		await writeFile(temporaryPath, createDevelopmentUnit(process.execPath, daemonBundle), {
			encoding: 'utf8',
			mode: 0o644,
		});
		await rename(temporaryPath, unitPath);
		await runSystemctlDaemonReload();
		console.log(`[agent-glow] installed development unit: ${unitPath}`);
		console.log('[agent-glow] unit was not enabled or started');
		return;
	}

	const loadState = await readSystemctlProperty('LoadState');
	if (loadState === 'loaded') {
		await runSystemctl(['disable', '--now', 'agent-glow.service']);
		console.log('[agent-glow] stopped and disabled Agent Glow service');
	}
	await unlink(unitPath).catch((error: unknown) => {
		if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
	});
	await runSystemctlDaemonReload();
	await runSystemctl(['mask', '--now', '--force', 'agent-glow.service']);
	console.log(`[agent-glow] removed development unit and masked service: ${unitPath}`);
}

function createDevelopmentUnit(nodePath: string, daemonBundle: string): string {
	return `[Unit]
Description=Agent Glow lighting state daemon (development)
After=graphical-session.target
PartOf=graphical-session.target
StartLimitIntervalSec=30s
StartLimitBurst=5

[Service]
Type=simple
Environment=AGENT_GLOW_BACKEND=asusd
ExecStart=${quoteSystemdArgument(nodePath)} ${quoteSystemdArgument(daemonBundle)}
Restart=on-failure
RestartSec=2s
TimeoutStopSec=7s

[Install]
WantedBy=graphical-session.target
`;
}

function quoteSystemdArgument(value: string): string {
	return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function runSystemctlDaemonReload(): Promise<void> {
	return runSystemctl(['daemon-reload']);
}

function runSystemctl(arguments_: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('systemctl', ['--user', ...arguments_], {
			shell: false,
			stdio: 'inherit',
		});
		child.once('error', reject);
		child.once('close', (exitCode) => {
			if (exitCode === 0) resolve();
			else
				reject(
					new Error(`systemctl --user ${arguments_.join(' ')} exited ${exitCode ?? 1}`),
				);
		});
	});
}

function readSystemctlProperty(property: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'systemctl',
			['--user', 'show', 'agent-glow.service', `--property=${property}`, '--value'],
			{
				shell: false,
				stdio: ['ignore', 'pipe', 'inherit'],
			},
		);
		let output = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			output += chunk;
		});
		child.once('error', reject);
		child.once('close', (exitCode) => {
			if (exitCode === 0) resolve(output.trim());
			else reject(new Error(`systemctl --user show exited ${exitCode ?? 1}`));
		});
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
