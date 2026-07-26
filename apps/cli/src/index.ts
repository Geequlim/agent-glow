import packageMetadata from '../package.json';

import { runCli } from './command.js';
import { sendRpcRequest } from './rpc-client.js';

process.exitCode = await runCli(
	process.argv.slice(2),
	packageMetadata.version,
	{
		writeError: (message) => process.stderr.write(message),
		writeOutput: (message) => process.stdout.write(message),
	},
	sendRpcRequest,
);
