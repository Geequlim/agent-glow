import { chmod, mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AgentGlowConfig } from '@agent-glow/protocol/config';

import { createDefaultConfig } from './defaults.js';
import { parseConfigYaml, stringifyConfigYaml } from './yaml.js';

export interface ConfigFileHandle {
	close(): Promise<void>;
	sync(): Promise<void>;
	writeFile(data: string): Promise<void>;
}

export interface ConfigFileSystem {
	chmod(targetPath: string, mode: number): Promise<void>;
	mkdir(
		targetPath: string,
		options: { readonly mode: number; readonly recursive: true },
	): Promise<unknown>;
	open(targetPath: string, flags: string, mode?: number): Promise<ConfigFileHandle>;
	readFile(targetPath: string, encoding: 'utf8'): Promise<string>;
	rename(oldPath: string, newPath: string): Promise<void>;
	unlink(targetPath: string): Promise<void>;
}

export interface PreparedConfigWrite {
	commit(): Promise<void>;
	discard(): Promise<void>;
}

const nodeFileSystem: ConfigFileSystem = {
	chmod,
	mkdir,
	open: (targetPath, flags, mode) => open(targetPath, flags, mode) as Promise<FileHandle>,
	readFile,
	rename,
	unlink,
};

export async function loadConfigFile(
	configPath: string,
	fileSystem: ConfigFileSystem = nodeFileSystem,
): Promise<AgentGlowConfig> {
	return parseConfigYaml(await fileSystem.readFile(configPath, 'utf8'));
}

export async function initializeConfigFile(
	configPath: string,
	fileSystem: ConfigFileSystem = nodeFileSystem,
): Promise<AgentGlowConfig> {
	try {
		return await loadConfigFile(configPath, fileSystem);
	} catch (error) {
		if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
	}
	const config = createDefaultConfig();
	await saveConfigFileAtomic(configPath, config, fileSystem);
	return config;
}

export async function saveConfigFileAtomic(
	configPath: string,
	config: AgentGlowConfig,
	fileSystem: ConfigFileSystem = nodeFileSystem,
): Promise<void> {
	const prepared = await prepareConfigFileAtomic(configPath, config, fileSystem);
	await prepared.commit();
}

export async function prepareConfigFileAtomic(
	configPath: string,
	config: AgentGlowConfig,
	fileSystem: ConfigFileSystem = nodeFileSystem,
): Promise<PreparedConfigWrite> {
	const serialized = stringifyConfigYaml(config);
	const directoryPath = path.dirname(configPath);
	const temporaryPath = temporaryFilePath(configPath, 'new');
	const previousContent = await readOptionalFile(configPath, fileSystem);
	let handle: ConfigFileHandle | undefined;
	let state: 'pending' | 'committed' | 'discarded' = 'pending';

	await fileSystem.mkdir(directoryPath, { recursive: true, mode: 0o700 });
	await fileSystem.chmod(directoryPath, 0o700);
	try {
		handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
		await handle.writeFile(serialized);
		await handle.sync();
		await handle.close();
		handle = undefined;
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		if (handle) await captureFailure(() => handle?.close(), cleanupErrors);
		await captureFailure(() => removeIfPresent(temporaryPath, fileSystem), cleanupErrors);
		if (cleanupErrors.length > 0)
			throw new AggregateError(
				[error, ...cleanupErrors],
				'Configuration write preparation failed',
			);
		throw error;
	}

	return {
		commit: async () => {
			if (state !== 'pending') throw new Error(`Configuration write is already ${state}`);
			let replaced = false;
			try {
				await fileSystem.rename(temporaryPath, configPath);
				replaced = true;
				await syncDirectory(directoryPath, fileSystem);
				state = 'committed';
			} catch (error) {
				const rollbackErrors: unknown[] = [];
				if (replaced) {
					await captureFailure(
						() => restorePreviousContent(configPath, previousContent, fileSystem),
						rollbackErrors,
					);
				}
				await captureFailure(
					() => removeIfPresent(temporaryPath, fileSystem),
					rollbackErrors,
				);
				state = 'discarded';
				if (rollbackErrors.length > 0) {
					throw new AggregateError(
						[error, ...rollbackErrors],
						'Atomic configuration commit failed',
					);
				}
				throw error;
			} finally {
				await removeIfPresent(temporaryPath, fileSystem);
			}
		},
		discard: async () => {
			if (state === 'committed') throw new Error('Cannot discard a committed configuration');
			if (state === 'discarded') return;
			await removeIfPresent(temporaryPath, fileSystem);
			state = 'discarded';
		},
	};
}

async function restorePreviousContent(
	configPath: string,
	previousContent: string | undefined,
	fileSystem: ConfigFileSystem,
): Promise<void> {
	const directoryPath = path.dirname(configPath);
	if (previousContent === undefined) {
		await removeIfPresent(configPath, fileSystem);
		await syncDirectoryBestEffort(directoryPath, fileSystem);
		return;
	}

	const rollbackPath = temporaryFilePath(configPath, 'rollback');
	let handle: ConfigFileHandle | undefined;
	try {
		handle = await fileSystem.open(rollbackPath, 'wx', 0o600);
		await handle.writeFile(previousContent);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fileSystem.rename(rollbackPath, configPath);
		await syncDirectoryBestEffort(directoryPath, fileSystem);
	} finally {
		if (handle) await handle.close().catch(() => undefined);
		await removeIfPresent(rollbackPath, fileSystem);
	}
}

async function syncDirectory(directoryPath: string, fileSystem: ConfigFileSystem): Promise<void> {
	const handle = await fileSystem.open(directoryPath, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectoryBestEffort(
	directoryPath: string,
	fileSystem: ConfigFileSystem,
): Promise<void> {
	await syncDirectory(directoryPath, fileSystem).catch(() => undefined);
}

async function readOptionalFile(
	configPath: string,
	fileSystem: ConfigFileSystem,
): Promise<string | undefined> {
	try {
		return await fileSystem.readFile(configPath, 'utf8');
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

async function removeIfPresent(targetPath: string, fileSystem: ConfigFileSystem): Promise<void> {
	await fileSystem.unlink(targetPath).catch((error: unknown) => {
		if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
	});
}

async function captureFailure(
	operation: () => Promise<unknown> | undefined,
	errors: unknown[],
): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(error);
	}
}

function temporaryFilePath(configPath: string, purpose: string): string {
	return `${configPath}.${process.pid}.${randomUUID()}.${purpose}.tmp`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
