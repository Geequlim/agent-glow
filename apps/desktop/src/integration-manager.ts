import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type IntegrationId = 'codex' | 'opencode' | 'zcode';
export type IntegrationAction = 'install' | 'remove';

export interface IntegrationPlan {
	readonly id: IntegrationId;
	readonly action: IntegrationAction;
	readonly targetPath: string;
	readonly before: string;
	readonly after: string;
	readonly diff: string;
}

export interface IntegrationStatus {
	readonly id: IntegrationId;
	readonly installed: boolean;
	readonly targetPath: string;
	readonly updateAvailable: boolean;
}

const CODEX_EVENTS = [
	'UserPromptSubmit',
	'PermissionRequest',
	'PreToolUse',
	'PostToolUse',
	'Stop',
	'SessionEnd',
] as const;
const ZCODE_EVENTS = [
	'SessionStart',
	'UserPromptSubmit',
	'PreToolUse',
	'PermissionRequest',
	'PostToolUse',
	'PostToolUseFailure',
	'Stop',
] as const;
const MARKER = 'AgentGlow integration';

export class IntegrationManager {
	readonly #codexHooksPath: string;
	readonly #openCodePluginPath: string;
	readonly #zcodeConfigPath: string;
	readonly #cliPath: string;
	readonly #nodePath: string;

	constructor(
		cliPath: string,
		options: {
			readonly codexHooksPath?: string;
			readonly nodePath?: string;
			readonly openCodePluginPath?: string;
			readonly zcodeConfigPath?: string;
		} = {},
	) {
		this.#cliPath = cliPath;
		this.#nodePath = options.nodePath ?? process.execPath;
		this.#codexHooksPath =
			options.codexHooksPath ?? path.join(homedir(), '.codex', 'hooks.json');
		this.#openCodePluginPath =
			options.openCodePluginPath ??
			path.join(homedir(), '.config', 'opencode', 'plugins', 'agent-glow.js');
		this.#zcodeConfigPath =
			options.zcodeConfigPath ?? path.join(homedir(), '.zcode', 'cli', 'config.json');
	}

	async statuses(): Promise<readonly IntegrationStatus[]> {
		const codex = await readOptional(this.#codexHooksPath);
		const openCode = await readOptional(this.#openCodePluginPath);
		const zcode = await readOptional(this.#zcodeConfigPath);
		const codexInstalled = codex ? containsAgentGlowHookDocument(codex) : false;
		const openCodeInstalled = openCode?.includes(MARKER) ?? false;
		const zcodeInstalled = zcode ? containsAgentGlowZcodeDocument(zcode) : false;
		return [
			{
				id: 'codex',
				installed: codexInstalled,
				targetPath: this.#codexHooksPath,
				updateAvailable:
					codexInstalled &&
					(!codex || updateCodexHooks(codex, this.#codexCommand(), 'install') !== codex),
			},
			{
				id: 'opencode',
				installed: openCodeInstalled,
				targetPath: this.#openCodePluginPath,
				updateAvailable: openCodeInstalled && openCode !== createOpenCodePlugin(),
			},
			{
				id: 'zcode',
				installed: zcodeInstalled,
				targetPath: this.#zcodeConfigPath,
				updateAvailable:
					zcodeInstalled &&
					(!zcode ||
						updateZcodeHooks(zcode, this.#nodePath, this.#cliPath, 'install') !==
							zcode),
			},
		];
	}

	async plan(id: IntegrationId, action: IntegrationAction): Promise<IntegrationPlan> {
		const targetPath =
			id === 'codex'
				? this.#codexHooksPath
				: id === 'opencode'
					? this.#openCodePluginPath
					: this.#zcodeConfigPath;
		const before = (await readOptional(targetPath)) ?? '';
		if (id === 'opencode' && before && !before.includes(MARKER)) {
			throw new Error('目标文件不是 AgentGlow 生成的 OpenCode 插件，拒绝覆盖或删除。');
		}
		const after =
			id === 'codex'
				? updateCodexHooks(before, this.#codexCommand(), action)
				: id === 'opencode'
					? action === 'install'
						? createOpenCodePlugin()
						: ''
					: updateZcodeHooks(before, this.#nodePath, this.#cliPath, action);
		return {
			id,
			action,
			targetPath,
			before,
			after,
			diff: createTextDiff(before, after),
		};
	}

	async apply(plan: IntegrationPlan): Promise<void> {
		const current = (await readOptional(plan.targetPath)) ?? '';
		if (current !== plan.before) {
			throw new Error('目标配置在确认期间发生变化，请重新预览。');
		}
		if (!plan.after) {
			await unlink(plan.targetPath).catch((error: unknown) => {
				if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
			});
			return;
		}
		await mkdir(path.dirname(plan.targetPath), { recursive: true, mode: 0o700 });
		const temporaryPath = `${plan.targetPath}.tmp-${process.pid}`;
		await writeFile(temporaryPath, plan.after, { encoding: 'utf8', mode: 0o600 });
		await rename(temporaryPath, plan.targetPath);
	}

	#codexCommand(): string {
		return `${shellQuote(this.#nodePath)} ${shellQuote(this.#cliPath)} adapt codex`;
	}
}

export function updateZcodeHooks(
	source: string,
	nodePath: string,
	cliPath: string,
	action: IntegrationAction,
): string {
	const document = source.trim() ? (JSON.parse(source) as Record<string, unknown>) : {};
	const hooks =
		document.hooks && typeof document.hooks === 'object'
			? (document.hooks as Record<string, unknown>)
			: {};
	const events =
		hooks.events && typeof hooks.events === 'object'
			? (hooks.events as Record<string, unknown>)
			: {};
	for (const event of ZCODE_EVENTS) {
		const groups = Array.isArray(events[event]) ? [...events[event]] : [];
		const filtered = groups.filter((group) => !containsAgentGlowHandler(group, ''));
		if (action === 'install') {
			filtered.push({
				hooks: [
					{
						type: 'process',
						command: nodePath,
						args: [cliPath, 'adapt', 'zcode'],
						timeoutMs: 2000,
						statusMessage: MARKER,
					},
				],
			});
		}
		if (filtered.length > 0) events[event] = filtered;
		else delete events[event];
	}
	if (action === 'install') hooks.enabled = true;
	hooks.events = events;
	document.hooks = hooks;
	return `${JSON.stringify(document, null, 2)}\n`;
}

export function updateCodexHooks(
	source: string,
	command: string,
	action: IntegrationAction,
): string {
	const document = source.trim()
		? (JSON.parse(source) as Record<string, unknown>)
		: { description: 'User lifecycle hooks.' };
	const hooks =
		document.hooks && typeof document.hooks === 'object'
			? (document.hooks as Record<string, unknown>)
			: {};
	for (const event of CODEX_EVENTS) {
		const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
		const filtered = groups.filter((group) => !containsAgentGlowHandler(group, command));
		if (action === 'install') {
			filtered.push({
				hooks: [
					{
						type: 'command',
						command,
						timeout: event === 'SessionEnd' ? 1 : 2,
						statusMessage: MARKER,
					},
				],
			});
		}
		if (filtered.length > 0) hooks[event] = filtered;
		else delete hooks[event];
	}
	document.hooks = hooks;
	return `${JSON.stringify(document, null, 2)}\n`;
}

export function createOpenCodePlugin(): string {
	return `// ${MARKER}
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

const socketPath = process.env.AGENT_GLOW_SOCKET ||
  path.join(process.env.XDG_RUNTIME_DIR || path.join(tmpdir(), \`agent-glow-\${process.getuid?.() ?? "user"}\`), "agent-glow", "daemon.sock")

function request(method, params) {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    const done = () => {
      socket.destroy()
      resolve()
    }
    socket.setTimeout(200)
    socket.once("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\\n"))
    socket.once("data", done)
    socket.once("error", done)
    socket.once("timeout", done)
  })
}

function emit(sessionId, state, phase, ttlMs) {
  if (!sessionId) return Promise.resolve()
  return request("event.emit", {
    event: { version: 1, source: "opencode", sessionId, state, phase, ...(ttlMs ? { ttlMs } : {}) },
  })
}

function clear(sessionId, state) {
  if (!sessionId) return Promise.resolve()
  return request("event.clear", { source: "opencode", sessionId, ...(state ? { state } : {}) })
}

const childSessions = new Set()
const completedSessions = new Set()
const activeToolCalls = new Map()

function trackSession(properties) {
  const sessionId = properties.sessionID || properties.info?.id
  if (!sessionId) return
  if (properties.info?.parentID) childSessions.add(sessionId)
  else childSessions.delete(sessionId)
}

async function finishSession(sessionId) {
  if (!sessionId || completedSessions.has(sessionId)) return
  completedSessions.add(sessionId)
  activeToolCalls.delete(sessionId)
  if (!childSessions.has(sessionId))
    await emit(sessionId, "success", "pulse")
  await clear(sessionId, "tool_use")
  await clear(sessionId, "working")
}

export const AgentGlowPlugin = async () => ({
  event: async ({ event }) => {
    const properties = event.properties || {}
    const sessionId = properties.sessionID || properties.info?.sessionID
    if (event.type === "session.created" || event.type === "session.updated")
      trackSession(properties)
    else if (event.type === "session.status" && properties.status?.type === "busy") {
      completedSessions.delete(sessionId)
      await emit(sessionId, "working", "enter")
    } else if (event.type === "session.status" && properties.status?.type === "idle")
      await finishSession(sessionId)
    else if (event.type === "permission.asked" || event.type === "permission.updated")
      await emit(sessionId, "waiting_permission", "enter")
    else if (event.type === "permission.replied")
      await clear(sessionId, "waiting_permission")
    else if (event.type === "session.idle")
      await finishSession(sessionId)
    else if (event.type === "session.error") {
      completedSessions.add(sessionId)
      activeToolCalls.delete(sessionId)
      await emit(sessionId, "error", "pulse")
      await clear(sessionId, "tool_use")
      await clear(sessionId, "working")
    } else if (event.type === "session.deleted") {
      await clear(sessionId)
      childSessions.delete(sessionId)
      completedSessions.delete(sessionId)
      activeToolCalls.delete(sessionId)
    }
  },
  "tool.execute.before": async (input) => {
    const calls = activeToolCalls.get(input.sessionID) || new Set()
    const firstCall = calls.size === 0
    calls.add(input.callID)
    activeToolCalls.set(input.sessionID, calls)
    completedSessions.delete(input.sessionID)
    if (!firstCall) return
    await clear(input.sessionID, "waiting_permission")
    await emit(input.sessionID, "tool_use", "enter")
  },
  "tool.execute.after": async (input) => {
    const calls = activeToolCalls.get(input.sessionID)
    if (!calls) return
    calls.delete(input.callID)
    if (calls.size > 0) return
    activeToolCalls.delete(input.sessionID)
    await clear(input.sessionID, "tool_use")
  },
})
`;
}

export function createTextDiff(before: string, after: string): string {
	if (before === after) return '无变化';
	const beforeLines = before.split('\n');
	const afterLines = after.split('\n');
	return [
		'--- 修改前',
		'+++ 修改后',
		...beforeLines.map((line) => `- ${line}`),
		...afterLines.map((line) => `+ ${line}`),
	].join('\n');
}

function containsAgentGlowHandler(value: unknown, command: string): boolean {
	if (!value || typeof value !== 'object' || !('hooks' in value)) return false;
	const handlers = value.hooks;
	return (
		Array.isArray(handlers) &&
		handlers.some(
			(handler) =>
				handler &&
				typeof handler === 'object' &&
				((Boolean(command) && 'command' in handler && handler.command === command) ||
					('statusMessage' in handler && handler.statusMessage === MARKER)),
		)
	);
}

function containsAgentGlowHookDocument(source: string): boolean {
	try {
		const document = JSON.parse(source) as { readonly hooks?: Record<string, unknown> };
		return Object.values(document.hooks ?? {}).some(
			(groups) =>
				Array.isArray(groups) &&
				groups.some((group) => containsAgentGlowHandler(group, '')),
		);
	} catch {
		return false;
	}
}

function containsAgentGlowZcodeDocument(source: string): boolean {
	try {
		const document = JSON.parse(source) as {
			readonly hooks?: { readonly events?: Record<string, unknown> };
		};
		return Object.values(document.hooks?.events ?? {}).some(
			(groups) =>
				Array.isArray(groups) &&
				groups.some((group) => containsAgentGlowHandler(group, '')),
		);
	} catch {
		return false;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readOptional(filePath: string): Promise<string | undefined> {
	return readFile(filePath, 'utf8').catch((error: unknown) => {
		if (isNodeError(error) && error.code === 'ENOENT') return undefined;
		throw error;
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
