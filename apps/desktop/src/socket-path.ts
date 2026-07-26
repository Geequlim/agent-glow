import { tmpdir } from 'node:os';
import path from 'node:path';

export function resolveSocketPath(environment: NodeJS.ProcessEnv = process.env): string {
	if (environment.AGENT_GLOW_SOCKET) return environment.AGENT_GLOW_SOCKET;
	const runtimeDirectory =
		environment.XDG_RUNTIME_DIR ??
		path.join(tmpdir(), `agent-glow-${process.getuid?.() ?? 'user'}`);
	return path.join(runtimeDirectory, 'agent-glow', 'daemon.sock');
}
