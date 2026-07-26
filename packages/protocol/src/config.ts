import { Type, type Static } from '@sinclair/typebox';

import { DeviceConfigurationValuesSchema } from './device-configuration.js';

const strict = { additionalProperties: false } as const;
const unitInterval = { minimum: 0, maximum: 1 } as const;
const HexColorSchema = Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' });
const commonProfileFields = {
	color: HexColorSchema,
	hardwareIntensity: Type.Number(unitInterval),
};

export const StaticProfileSchema = Type.Object(
	{
		...commonProfileFields,
		effect: Type.Literal('static'),
		intensity: Type.Number(unitInterval),
	},
	strict,
);

export const BreatheProfileSchema = Type.Object(
	{
		...commonProfileFields,
		effect: Type.Literal('breathe'),
		minimumIntensity: Type.Number(unitInterval),
		maximumIntensity: Type.Number(unitInterval),
		periodMs: Type.Integer({ minimum: 250, maximum: 10_000 }),
	},
	strict,
);

export const PulseProfileSchema = Type.Object(
	{
		...commonProfileFields,
		effect: Type.Literal('pulse'),
		minimumIntensity: Type.Number(unitInterval),
		maximumIntensity: Type.Number(unitInterval),
		durationMs: Type.Integer({ minimum: 100, maximum: 10_000 }),
		pulseCount: Type.Integer({ minimum: 1, maximum: 4 }),
	},
	strict,
);

export const VisualProfileSchema = Type.Union([
	StaticProfileSchema,
	BreatheProfileSchema,
	PulseProfileSchema,
]);

export const AgentGlowConfigSchema = Type.Object(
	{
		version: Type.Literal(1),
		daemon: Type.Object(
			{
				frameRate: Type.Integer({ minimum: 5, maximum: 20 }),
				staleSessionTimeoutMs: Type.Integer({ minimum: 1000, maximum: 86_400_000 }),
			},
			strict,
		),
		rendering: Type.Object(
			{
				colorSpace: Type.Literal('linear-rgb'),
				restoreOnExit: Type.Boolean(),
				transitionMs: Type.Integer({ minimum: 0, maximum: 2000 }),
			},
			strict,
		),
		profiles: Type.Object(
			{
				working: VisualProfileSchema,
				waiting_permission: VisualProfileSchema,
				success: VisualProfileSchema,
				error: VisualProfileSchema,
				paused: VisualProfileSchema,
			},
			strict,
		),
		devices: Type.Record(
			Type.String({
				minLength: 1,
				maxLength: 160,
				pattern: '^[A-Za-z0-9][A-Za-z0-9:._-]*$',
			}),
			DeviceConfigurationValuesSchema,
			{ ...strict, maxProperties: 64 },
		),
	},
	strict,
);

export type AgentGlowConfig = Static<typeof AgentGlowConfigSchema>;
export type VisualProfile = Static<typeof VisualProfileSchema>;
