import { AgentGlowConfigSchema, type AgentGlowConfig } from '@agent-glow/protocol/config';
import { Value } from '@sinclair/typebox/value';
import { parseDocument, stringify } from 'yaml';

export class ConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigValidationError';
	}
}

export function parseConfigYaml(source: string): AgentGlowConfig {
	const document = parseDocument(source, {
		merge: false,
		prettyErrors: true,
		uniqueKeys: true,
	});
	if (document.errors.length > 0) {
		throw new ConfigValidationError(`Invalid YAML: ${document.errors[0]?.message}`);
	}
	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: 0 });
	} catch (error) {
		throw new ConfigValidationError(
			`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return validateConfigValue(migrateConfig(value));
}

export function stringifyConfigYaml(config: AgentGlowConfig): string {
	validateConfigValue(config);
	return stringify(config, { indent: 2, lineWidth: 0 });
}

export function validateConfigValue(value: unknown): AgentGlowConfig {
	if (!Value.Check(AgentGlowConfigSchema, value)) {
		const firstError = [...Value.Errors(AgentGlowConfigSchema, value)][0];
		throw new ConfigValidationError(
			`Invalid Agent Glow configuration${
				firstError ? ` at ${firstError.path || '/'}: ${firstError.message}` : ''
			}`,
		);
	}
	for (const [state, profile] of Object.entries(value.profiles)) {
		if (profile.effect !== 'static' && profile.minimumIntensity > profile.maximumIntensity) {
			throw new ConfigValidationError(
				`Invalid Agent Glow configuration at /profiles/${state}: minimumIntensity must not exceed maximumIntensity`,
			);
		}
	}
	return value;
}

export function migrateConfig(value: unknown): unknown {
	const version =
		value && typeof value === 'object' && 'version' in value ? value.version : undefined;
	if (version === 1) return value;
	throw new ConfigValidationError(
		`Unsupported Agent Glow configuration version: ${String(version)}`,
	);
}
