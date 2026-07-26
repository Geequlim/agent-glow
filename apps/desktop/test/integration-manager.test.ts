import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	createOpenCodePlugin,
	IntegrationManager,
	updateCodexHooks,
} from '../src/integration-manager.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe('updateCodexHooks', () => {
	it('preserves unrelated hooks and installs exactly one AgentGlow handler per event', () => {
		const command = "'/usr/bin/node' '/opt/agent-glow/cli.cjs' adapt codex";
		const source = JSON.stringify({
			description: 'Existing hooks',
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-hook' }] }],
			},
		});

		const once = updateCodexHooks(source, command, 'install');
		const twice = updateCodexHooks(once, command, 'install');
		const parsed = JSON.parse(twice);

		expect(parsed.description).toBe('Existing hooks');
		expect(parsed.hooks.UserPromptSubmit).toHaveLength(2);
		expect(twice.match(/AgentGlow integration/gu)).toHaveLength(6);
	});

	it('removes only AgentGlow handlers', () => {
		const command = "'node' 'agent-glow' adapt codex";
		const installed = updateCodexHooks(
			JSON.stringify({
				hooks: {
					Stop: [{ hooks: [{ type: 'command', command: 'other-hook' }] }],
				},
			}),
			command,
			'install',
		);
		const removed = JSON.parse(updateCodexHooks(installed, command, 'remove'));

		expect(removed.hooks.Stop).toEqual([
			{ hooks: [{ type: 'command', command: 'other-hook' }] },
		]);
		expect(JSON.stringify(removed)).not.toContain(command);
	});

	it('upgrades an older AgentGlow command instead of duplicating it', () => {
		const oldCommand = "'node' '/old/agent-glow.cjs' adapt codex";
		const newCommand = "'node' '/new/agent-glow.cjs' adapt codex";
		const oldConfiguration = updateCodexHooks('', oldCommand, 'install');
		const upgraded = updateCodexHooks(oldConfiguration, newCommand, 'install');

		expect(upgraded).not.toContain(oldCommand);
		expect(upgraded.match(/AgentGlow integration/gu)).toHaveLength(6);
		expect(upgraded.match(/\/new\/agent-glow\.cjs/gu)).toHaveLength(6);
	});
});

describe('IntegrationManager', () => {
	it('previews and atomically applies both integrations in isolated paths', async () => {
		const root = await createTemporaryDirectory();
		const codexHooksPath = path.join(root, 'codex', 'hooks.json');
		const openCodePluginPath = path.join(root, 'opencode', 'agent-glow.js');
		const manager = new IntegrationManager('/opt/agent glow/cli.cjs', {
			codexHooksPath,
			nodePath: '/usr/bin/node',
			openCodePluginPath,
		});

		for (const id of ['codex', 'opencode'] as const) {
			const plan = await manager.plan(id, 'install');
			expect(plan.before).toBe('');
			expect(plan.diff).toContain('+++ 修改后');
			await manager.apply(plan);
		}

		expect(await manager.statuses()).toEqual([
			{
				id: 'codex',
				installed: true,
				targetPath: codexHooksPath,
				updateAvailable: false,
			},
			{
				id: 'opencode',
				installed: true,
				targetPath: openCodePluginPath,
				updateAvailable: false,
			},
		]);
		expect(await readFile(codexHooksPath, 'utf8')).toContain(
			"'/usr/bin/node' '/opt/agent glow/cli.cjs' adapt codex",
		);
		expect(await readFile(openCodePluginPath, 'utf8')).toBe(createOpenCodePlugin());
	});

	it('rejects applying a stale preview', async () => {
		const root = await createTemporaryDirectory();
		const codexHooksPath = path.join(root, 'hooks.json');
		const manager = new IntegrationManager('/opt/agent-glow/cli.cjs', {
			codexHooksPath,
			openCodePluginPath: path.join(root, 'agent-glow.js'),
		});
		const plan = await manager.plan('codex', 'install');
		await writeFile(codexHooksPath, '{}');

		await expect(manager.apply(plan)).rejects.toThrow('确认期间发生变化');
	});

	it('refuses to remove an OpenCode plugin it does not own', async () => {
		const root = await createTemporaryDirectory();
		const openCodePluginPath = path.join(root, 'agent-glow.js');
		await writeFile(openCodePluginPath, 'export const SomeoneElse = () => ({})\n');
		const manager = new IntegrationManager('/opt/agent-glow/cli.cjs', {
			codexHooksPath: path.join(root, 'hooks.json'),
			openCodePluginPath,
		});

		await expect(manager.plan('opencode', 'remove')).rejects.toThrow('拒绝覆盖或删除');
		await expect(manager.plan('opencode', 'install')).rejects.toThrow('拒绝覆盖或删除');
	});

	it('detects an outdated owned OpenCode plugin and prepares an upgrade', async () => {
		const root = await createTemporaryDirectory();
		const openCodePluginPath = path.join(root, 'agent-glow.js');
		await writeFile(openCodePluginPath, '// AgentGlow integration\n// old version\n');
		const manager = new IntegrationManager('/opt/agent-glow/cli.cjs', {
			codexHooksPath: path.join(root, 'hooks.json'),
			openCodePluginPath,
		});

		expect((await manager.statuses())[1]).toMatchObject({
			installed: true,
			updateAvailable: true,
		});
		const plan = await manager.plan('opencode', 'install');
		expect(plan.diff).toContain('session.status');
		await manager.apply(plan);
		expect((await manager.statuses())[1]).toMatchObject({
			installed: true,
			updateAvailable: false,
		});
	});
});

describe('createOpenCodePlugin', () => {
	it('covers the OpenCode working, permission, completion and cleanup lifecycle', async () => {
		const plugin = createOpenCodePlugin();

		for (const event of [
			'session.created',
			'session.updated',
			'session.status',
			'permission.asked',
			'permission.replied',
			'tool.execute.before',
			'tool.execute.after',
			'session.idle',
			'session.error',
			'session.deleted',
		])
			expect(plugin).toContain(event);
		expect(plugin).not.toContain('message.updated');
		expect(plugin).toContain('childSessions');
		expect(plugin).toContain('completedSessions');
		expect(plugin).toContain('// AgentGlow integration');

		const encoded = Buffer.from(plugin).toString('base64');
		const loaded: unknown = await import(`data:text/javascript;base64,${encoded}`);
		expect(loaded).toBeTypeOf('object');
		expect(loaded).toHaveProperty('AgentGlowPlugin');
	});

	it('keeps child completion silent and completes the root session exactly once', async () => {
		const root = await createTemporaryDirectory();
		const socketPath = path.join(root, 'daemon.sock');
		const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
		const server = createServer((socket) => {
			socket.once('data', (chunk) => {
				requests.push(JSON.parse(chunk.toString().trim()));
				socket.end('{}\n');
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(socketPath, resolve);
		});
		const previousSocketPath = process.env.AGENT_GLOW_SOCKET;
		process.env.AGENT_GLOW_SOCKET = socketPath;
		try {
			const encoded = Buffer.from(createOpenCodePlugin()).toString('base64');
			const loaded = (await import(
				`data:text/javascript;base64,${encoded}#runtime`
			)) as unknown as {
				readonly AgentGlowPlugin: () => Promise<{
					readonly event: (input: { readonly event: unknown }) => Promise<void>;
					readonly 'tool.execute.before': (input: {
						readonly sessionID: string;
						readonly callID: string;
					}) => Promise<void>;
					readonly 'tool.execute.after': (input: {
						readonly sessionID: string;
						readonly callID: string;
					}) => Promise<void>;
				}>;
			};
			const plugin = await loaded.AgentGlowPlugin();
			const send = (type: string, properties: Record<string, unknown>): Promise<void> =>
				plugin.event({ event: { type, properties } });

			await send('session.created', {
				sessionID: 'root',
				info: { id: 'root' },
			});
			await send('session.status', {
				sessionID: 'root',
				status: { type: 'busy' },
			});
			await send('permission.asked', { sessionID: 'root' });
			await plugin['tool.execute.before']({ sessionID: 'root', callID: 'call-1' });
			await plugin['tool.execute.before']({ sessionID: 'root', callID: 'call-2' });
			await plugin['tool.execute.after']({ sessionID: 'root', callID: 'call-1' });
			await plugin['tool.execute.after']({ sessionID: 'root', callID: 'call-2' });
			await send('session.created', {
				sessionID: 'child',
				info: { id: 'child', parentID: 'root' },
			});
			await send('session.status', {
				sessionID: 'child',
				status: { type: 'busy' },
			});
			await send('session.idle', { sessionID: 'child' });
			await send('session.status', {
				sessionID: 'root',
				status: { type: 'idle' },
			});
			await send('session.idle', { sessionID: 'root' });

			expect(requests).toEqual([
				expect.objectContaining({
					method: 'event.emit',
					params: expect.objectContaining({
						event: expect.objectContaining({
							sessionId: 'root',
							state: 'working',
						}),
					}),
				}),
				expect.objectContaining({
					method: 'event.emit',
					params: expect.objectContaining({
						event: expect.objectContaining({
							sessionId: 'root',
							state: 'waiting_permission',
						}),
					}),
				}),
				expect.objectContaining({
					method: 'event.clear',
					params: {
						source: 'opencode',
						sessionId: 'root',
						state: 'waiting_permission',
					},
				}),
				expect.objectContaining({
					method: 'event.emit',
					params: expect.objectContaining({
						event: expect.objectContaining({
							sessionId: 'root',
							state: 'tool_use',
						}),
					}),
				}),
				expect.objectContaining({
					method: 'event.clear',
					params: { source: 'opencode', sessionId: 'root', state: 'tool_use' },
				}),
				expect.objectContaining({
					method: 'event.emit',
					params: expect.objectContaining({
						event: expect.objectContaining({
							sessionId: 'child',
							state: 'working',
						}),
					}),
				}),
				expect.objectContaining({
					method: 'event.clear',
					params: { source: 'opencode', sessionId: 'child', state: 'tool_use' },
				}),
				expect.objectContaining({
					method: 'event.clear',
					params: { source: 'opencode', sessionId: 'child', state: 'working' },
				}),
				expect.objectContaining({
					method: 'event.emit',
					params: expect.objectContaining({
						event: expect.objectContaining({
							sessionId: 'root',
							state: 'success',
						}),
					}),
				}),
				expect.objectContaining({
					method: 'event.clear',
					params: { source: 'opencode', sessionId: 'root', state: 'tool_use' },
				}),
				expect.objectContaining({
					method: 'event.clear',
					params: { source: 'opencode', sessionId: 'root', state: 'working' },
				}),
			]);
		} finally {
			if (previousSocketPath === undefined) delete process.env.AGENT_GLOW_SOCKET;
			else process.env.AGENT_GLOW_SOCKET = previousSocketPath;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		}
	});
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'agent-glow-integration-'));
	temporaryDirectories.push(directory);
	return directory;
}
