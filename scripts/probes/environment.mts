import { spawnSync } from 'node:child_process';

interface CommandResult {
	readonly available: boolean;
	readonly output?: string;
}

function run(command: string, args: readonly string[]): CommandResult {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.error || result.status !== 0) return { available: false };

	const output = result.stdout.trim() || result.stderr.trim();
	return output.length > 0 ? { available: true, output } : { available: true };
}

function executableVersion(command: string, args: readonly string[]): string | null {
	const result = run(command, args);
	return result.available ? (result.output ?? 'available') : null;
}

const environment = {
	platform: {
		os: process.platform,
		architecture: process.arch,
		node: process.version,
		nodeAbi: process.versions.modules,
	},
	tools: {
		yarn:
			process.env.npm_config_user_agent?.split(' ')[0] ??
			executableVersion('yarn', ['--version']),
		codex: executableVersion('codex', ['--version']),
		claudeCode: executableVersion('claude', ['--version']),
		opencode: executableVersion('opencode', ['--version']),
		asusctlPackage: executableVersion('pacman', ['-Q', 'asusctl']),
	},
	nativeLibraries: {
		gtk4: executableVersion('pkg-config', ['--modversion', 'gtk4']),
		libadwaita: executableVersion('pkg-config', ['--modversion', 'libadwaita-1']),
		gobjectIntrospection: executableVersion('pkg-config', [
			'--modversion',
			'gobject-introspection-1.0',
		]),
	},
};

console.log(JSON.stringify(environment, null, 2));
