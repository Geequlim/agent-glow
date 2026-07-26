import {
	chmod,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	unlink,
	type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	createDefaultConfig,
	initializeConfigFile,
	loadConfigFile,
	prepareConfigFileAtomic,
	saveConfigFileAtomic,
	type ConfigFileHandle,
	type ConfigFileSystem,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe('configuration file storage', () => {
	it('creates a default file with restricted permissions and loads it again', async () => {
		const configPath = await temporaryConfigPath();

		const created = await initializeConfigFile(configPath);
		const loaded = await initializeConfigFile(configPath);

		expect(created).toEqual(createDefaultConfig());
		expect(loaded).toEqual(created);
		expect((await stat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
		expect((await stat(configPath)).mode & 0o777).toBe(0o600);
		expect(await temporaryFiles(configPath)).toEqual([]);
	});

	it('atomically replaces an existing valid configuration', async () => {
		const configPath = await temporaryConfigPath();
		await initializeConfigFile(configPath);
		const updated = createDefaultConfig();
		updated.rendering.transitionMs = 450;

		await saveConfigFileAtomic(configPath, updated);

		expect(await loadConfigFile(configPath)).toEqual(updated);
		expect(await temporaryFiles(configPath)).toEqual([]);
	});

	it('keeps the formal file unchanged until a prepared write is committed', async () => {
		const configPath = await temporaryConfigPath();
		const oldConfig = createDefaultConfig();
		await saveConfigFileAtomic(configPath, oldConfig);
		const updated = createDefaultConfig();
		updated.rendering.transitionMs = 600;

		const prepared = await prepareConfigFileAtomic(configPath, updated);

		expect(await loadConfigFile(configPath)).toEqual(oldConfig);
		expect(await temporaryFiles(configPath)).toHaveLength(1);
		await prepared.commit();
		expect(await loadConfigFile(configPath)).toEqual(updated);
		expect(await temporaryFiles(configPath)).toEqual([]);
	});

	it('discards a prepared write without changing the formal file', async () => {
		const configPath = await temporaryConfigPath();
		const oldConfig = createDefaultConfig();
		await saveConfigFileAtomic(configPath, oldConfig);
		const updated = createDefaultConfig();
		updated.rendering.transitionMs = 600;

		const prepared = await prepareConfigFileAtomic(configPath, updated);
		await prepared.discard();

		expect(await loadConfigFile(configPath)).toEqual(oldConfig);
		expect(await temporaryFiles(configPath)).toEqual([]);
	});

	it('does not replace an existing invalid configuration during initialization', async () => {
		const configPath = await temporaryConfigPath();
		await mkdir(path.dirname(configPath), { recursive: true });
		await import('node:fs/promises').then(({ writeFile }) =>
			writeFile(configPath, 'version: [invalid\n'),
		);

		await expect(initializeConfigFile(configPath)).rejects.toThrow('Invalid YAML');

		expect(await readFile(configPath, 'utf8')).toBe('version: [invalid\n');
	});

	it('removes a first-created file when directory synchronization fails', async () => {
		const configPath = await temporaryConfigPath();

		await expect(
			saveConfigFileAtomic(
				configPath,
				createDefaultConfig(),
				failingFileSystem('sync-directory'),
			),
		).rejects.toThrow('injected sync-directory failure');

		await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await temporaryFiles(configPath)).toEqual([]);
	});

	for (const failurePoint of [
		'mkdir',
		'chmod',
		'open-temporary',
		'write',
		'sync-file',
		'rename',
		'open-directory',
		'sync-directory',
	] as const) {
		it(`preserves the old configuration when ${failurePoint} fails`, async () => {
			const configPath = await temporaryConfigPath();
			const oldConfig = createDefaultConfig();
			await saveConfigFileAtomic(configPath, oldConfig);
			const oldSource = await readFile(configPath, 'utf8');
			const updated = createDefaultConfig();
			updated.daemon.frameRate = 15;

			await expect(
				saveConfigFileAtomic(configPath, updated, failingFileSystem(failurePoint)),
			).rejects.toThrow(`injected ${failurePoint} failure`);

			expect(await readFile(configPath, 'utf8')).toBe(oldSource);
			expect(await loadConfigFile(configPath)).toEqual(oldConfig);
			expect(await temporaryFiles(configPath)).toEqual([]);
		});
	}
});

type FailurePoint =
	| 'chmod'
	| 'mkdir'
	| 'open-directory'
	| 'open-temporary'
	| 'rename'
	| 'sync-directory'
	| 'sync-file'
	| 'write';

function failingFileSystem(failurePoint: FailurePoint): ConfigFileSystem {
	let injected = false;
	const fail = (point: FailurePoint): void => {
		if (!injected && failurePoint === point) {
			injected = true;
			throw new Error(`injected ${point} failure`);
		}
	};
	return {
		async chmod(targetPath, mode) {
			fail('chmod');
			await chmod(targetPath, mode);
		},
		async mkdir(targetPath, options) {
			fail('mkdir');
			return mkdir(targetPath, options);
		},
		async open(targetPath, flags, mode) {
			const directory = flags === 'r';
			fail(directory ? 'open-directory' : 'open-temporary');
			const handle = await open(targetPath, flags, mode);
			return wrapHandle(handle, directory, fail);
		},
		readFile,
		async rename(oldPath, newPath) {
			fail('rename');
			await rename(oldPath, newPath);
		},
		unlink,
	};
}

function wrapHandle(
	handle: FileHandle,
	directory: boolean,
	fail: (point: FailurePoint) => void,
): ConfigFileHandle {
	return {
		close: () => handle.close(),
		async sync() {
			fail(directory ? 'sync-directory' : 'sync-file');
			await handle.sync();
		},
		async writeFile(data) {
			fail('write');
			await handle.writeFile(data);
		},
	};
}

async function temporaryConfigPath(): Promise<string> {
	const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
		mkdtemp(path.join(tmpdir(), 'agent-glow-config-')),
	);
	temporaryDirectories.push(directory);
	return path.join(directory, 'nested', 'config.yaml');
}

async function temporaryFiles(configPath: string): Promise<readonly string[]> {
	const directory = path.dirname(configPath);
	const entries = await readdir(directory).catch((error: unknown) => {
		if (isNodeError(error) && error.code === 'ENOENT') return [];
		throw error;
	});
	return entries.filter((entry) => entry.endsWith('.tmp'));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
