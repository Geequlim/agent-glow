import type { AgentGlowConfig } from '@agent-glow/protocol/config';
import type { SemanticState } from '@agent-glow/protocol/semantic-state';
import {
	initializeConfigFile,
	prepareConfigFileAtomic,
	resolveConfigPath,
	type PreparedConfigWrite,
} from '@agent-glow/config';
import type { RgbColor } from '@agent-glow/core/backend';
import type { SemanticVisualEffect } from '@agent-glow/core/semantic-visual-state';

export interface DaemonConfigRepository {
	load(): Promise<AgentGlowConfig>;
	prepare(config: AgentGlowConfig): Promise<PreparedConfigWrite>;
}

export function createFileConfigRepository(
	configPath = resolveConfigPath(),
): DaemonConfigRepository {
	return {
		load: () => initializeConfigFile(configPath),
		prepare: (config) => prepareConfigFileAtomic(configPath, config),
	};
}

export function configuredVisualEffect(
	config: AgentGlowConfig,
	state: Exclude<SemanticState, 'idle'>,
): SemanticVisualEffect {
	const profile = config.profiles[state];
	const common = {
		hardwareIntensity: profile.hardwareIntensity,
		semanticState: state,
	};
	if (profile.effect === 'static') {
		return {
			...common,
			color: parseHexColor(profile.color),
			effect: profile.effect,
			intensity: profile.intensity,
		};
	}
	const animatedColors = {
		startColor: parseHexColor(profile.startColor),
		endColor: parseHexColor(profile.endColor),
	};
	if (profile.effect === 'breathe' || profile.effect === 'stream') {
		return {
			...common,
			...animatedColors,
			effect: profile.effect,
			minimumIntensity: profile.minimumIntensity,
			maximumIntensity: profile.maximumIntensity,
			periodMs: profile.periodMs,
		};
	}
	return {
		...common,
		...animatedColors,
		effect: profile.effect,
		minimumIntensity: profile.minimumIntensity,
		maximumIntensity: profile.maximumIntensity,
		durationMs: profile.durationMs,
		pulseCount: profile.pulseCount,
	};
}

function parseHexColor(color: string): RgbColor {
	return {
		red: Number.parseInt(color.slice(1, 3), 16),
		green: Number.parseInt(color.slice(3, 5), 16),
		blue: Number.parseInt(color.slice(5, 7), 16),
	};
}
