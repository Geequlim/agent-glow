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

	await unlink(unitPath).catch((error: unknown) => {
		if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
	});
	await runSystemctlDaemonReload();
	console.log(`[agent-glow] removed development unit: ${unitPath}`);
}

function createDevelopmentUnit(nodePath: string, daemonBundle: string): string {
	return `[Unit]
Description=AgentGlow lighting state daemon (development)
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
	return new Promise((resolve, reject) => {
		const child = spawn('systemctl', ['--user', 'daemon-reload'], {
			shell: false,
			stdio: 'inherit',
		});
		child.once('error', reject);
		child.once('close', (exitCode) => {
			if (exitCode === 0) resolve();
			else reject(new Error(`systemctl --user daemon-reload exited ${exitCode ?? 1}`));
		});
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
