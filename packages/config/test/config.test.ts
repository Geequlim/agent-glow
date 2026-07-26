import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	ConfigValidationError,
	createDefaultConfig,
	parseConfigYaml,
	resolveConfigPath,
	stringifyConfigYaml,
} from '../src/index.js';

describe('configuration contract', () => {
	it('round-trips the default configuration through YAML', () => {
		const config = createDefaultConfig();

		expect(parseConfigYaml(stringifyConfigYaml(config))).toEqual(config);
	});

	it('keeps default configuration instances independent', () => {
		const first = createDefaultConfig();
		const second = createDefaultConfig();

		first.devices['example:light-1'] = { brightness: 10 };

		expect(second.devices).toEqual({});
	});

	it('validates the checked-in example with the same schema', async () => {
		const source = await readFile(
			path.resolve(import.meta.dirname, '../../../configs/config.example.yaml'),
			'utf8',
		);

		expect(parseConfigYaml(source)).toEqual(createDefaultConfig());
	});

	it('rejects duplicate YAML keys, aliases, unknown fields and versions', () => {
		expect(() => parseConfigYaml('version: 1\nversion: 1\n')).toThrow(ConfigValidationError);
		expect(() => parseConfigYaml('version: &version 1\ncopy: *version\n')).toThrow(
			ConfigValidationError,
		);
		expect(() =>
			parseConfigYaml(`${stringifyConfigYaml(createDefaultConfig())}unknown: true\n`),
		).toThrow(ConfigValidationError);
		const unknownVersion = stringifyConfigYaml(createDefaultConfig()).replace(
			'version: 1',
			'version: 2',
		);
		expect(() => parseConfigYaml(unknownVersion)).toThrow(
			'Unsupported AgentGlow configuration version: 2',
		);
	});

	it('rejects an intensity range whose minimum exceeds its maximum', () => {
		const config = createDefaultConfig();
		const working = config.profiles.working;
		if (working.effect !== 'breathe') throw new Error('Working fixture must breathe');
		config.profiles.working = {
			...working,
			minimumIntensity: 0.9,
			maximumIntensity: 0.2,
		};

		expect(() => parseConfigYaml(stringifyUnchecked(config))).toThrow(
			'minimumIntensity must not exceed maximumIntensity',
		);
	});
});

describe('resolveConfigPath', () => {
	it('uses an absolute XDG_CONFIG_HOME', () => {
		expect(resolveConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/example')).toBe(
			'/xdg/agent-glow/config.yaml',
		);
	});

	it('falls back to the injected home for missing or relative XDG paths', () => {
		expect(resolveConfigPath({}, '/home/example')).toBe(
			'/home/example/.config/agent-glow/config.yaml',
		);
		expect(resolveConfigPath({ XDG_CONFIG_HOME: 'relative' }, '/home/example')).toBe(
			'/home/example/.config/agent-glow/config.yaml',
		);
	});
});

function stringifyUnchecked(value: unknown): string {
	return JSON.stringify(value);
}
