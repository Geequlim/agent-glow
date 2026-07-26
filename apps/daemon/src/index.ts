import path from 'node:path';

import packageMetadata from '../package.json';

import { runDaemonCli } from './command.js';
import { startDaemonServer } from './server.js';

process.exitCode = runDaemonCli(
	process.argv.slice(2),
	packageMetadata.version,
	{
		writeError: (message) => process.stderr.write(message),
		writeOutput: (message) => process.stdout.write(message),
	},
	startDaemonScaffold,
);

function startDaemonScaffold(): void {
	let stopping = false;
	const serviceEntry = process.argv[1] ? path.resolve(process.argv[1]) : 'unknown';
	console.log(`[agent-glow] service source entry=${serviceEntry} runtime=${process.execPath}`);

	void startDaemonServer(packageMetadata.version)
		.then((daemon) => {
			const shutdown = (signal: NodeJS.Signals): void => {
				if (stopping) return;
				stopping = true;
				void daemon
					.close()
					.then(() => console.log(`[agent-glow] received ${signal}, stopping`))
					.catch(reportStartupError);
			};

			process.once('SIGINT', () => shutdown('SIGINT'));
			process.once('SIGTERM', () => shutdown('SIGTERM'));
			console.log(`[agent-glow] daemon started at ${daemon.socketPath}`);
		})
		.catch(reportStartupError);
}

function reportStartupError(error: unknown): void {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
