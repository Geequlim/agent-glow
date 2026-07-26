import packageMetadata from '../package.json';

import { runDesktopApplication } from './application.js';
import { runDesktopCli } from './command.js';
import { createGtkApplication } from './gtk-application.js';

process.exitCode = runDesktopCli(
	process.argv.slice(2),
	packageMetadata.version,
	{
		writeError: (message) => process.stderr.write(message),
		writeOutput: (message) => process.stdout.write(message),
	},
	() => runDesktopApplication(createGtkApplication),
);
