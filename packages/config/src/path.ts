import { homedir } from 'node:os';
import path from 'node:path';

export function resolveConfigPath(
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory = homedir(),
): string {
	const xdgConfigHome = environment.XDG_CONFIG_HOME;
	const configRoot =
		xdgConfigHome && path.isAbsolute(xdgConfigHome)
			? xdgConfigHome
			: path.join(homeDirectory, '.config');
	return path.join(configRoot, 'agent-glow', 'config.yaml');
}
