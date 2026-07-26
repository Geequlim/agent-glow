import { Type, type Static } from '@sinclair/typebox';

import { AgentGlowConfigSchema } from './config.js';
import { DeviceDescriptorSchema } from './device.js';
import {
	DeviceConfigurationSchema,
	DeviceConfigurationValuesSchema,
} from './device-configuration.js';
import { AgentGlowEventSchema } from './event.js';
import { PROTOCOL_LIMITS, PROTOCOL_VERSION } from './limits.js';
import { SemanticStateSchema } from './semantic-state.js';

const strict = { additionalProperties: false } as const;
const JsonRpcIdSchema = Type.Union([
	Type.Integer({ minimum: 0 }),
	Type.String({ minLength: 1, maxLength: 64 }),
]);
const EmptyParamsSchema = Type.Object({}, strict);
const PreviewStateSchema = Type.Exclude(SemanticStateSchema, Type.Literal('idle'));
const SourceSessionSchema = {
	source: Type.String({ minLength: 1, maxLength: PROTOCOL_LIMITS.maxSourceLength }),
	sessionId: Type.String({ minLength: 1, maxLength: PROTOCOL_LIMITS.maxSessionIdLength }),
};

export const InitializeParamsSchema = Type.Object(
	{
		protocolVersion: Type.Literal(PROTOCOL_VERSION),
		clientName: Type.String({ minLength: 1, maxLength: 64 }),
	},
	strict,
);

export const EventEmitParamsSchema = Type.Object({ event: AgentGlowEventSchema }, strict);
export const EventClearParamsSchema = Type.Object(
	{
		...SourceSessionSchema,
		state: Type.Optional(SemanticStateSchema),
	},
	strict,
);
export const EventTransitionParamsSchema = Type.Object(
	{
		...SourceSessionSchema,
		clearStates: Type.Array(SemanticStateSchema, {
			maxItems: 7,
			uniqueItems: true,
		}),
		event: Type.Optional(
			Type.Object(
				{
					state: SemanticStateSchema,
					phase: Type.Union([
						Type.Literal('enter'),
						Type.Literal('leave'),
						Type.Literal('pulse'),
					]),
					ttlMs: Type.Optional(
						Type.Integer({
							minimum: 1,
							maximum: PROTOCOL_LIMITS.maxTtlMs,
						}),
					),
				},
				strict,
			),
		),
	},
	strict,
);
export const DeviceConfigurationGetParamsSchema = Type.Object(
	{ deviceId: DeviceDescriptorSchema.properties.id },
	strict,
);
export const DeviceConfigurationUpdateParamsSchema = Type.Object(
	{
		deviceId: DeviceDescriptorSchema.properties.id,
		values: DeviceConfigurationValuesSchema,
	},
	strict,
);
export const ConfigUpdateParamsSchema = Type.Object({ config: AgentGlowConfigSchema }, strict);
export const PreviewSetParamsSchema = Type.Object({ state: PreviewStateSchema }, strict);

export const RpcRequestSchema = Type.Union([
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('initialize'),
			params: InitializeParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('daemon.getStatus'),
			params: EmptyParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('config.get'),
			params: EmptyParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('config.validate'),
			params: ConfigUpdateParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('config.update'),
			params: ConfigUpdateParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('device.list'),
			params: EmptyParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('device.config.get'),
			params: DeviceConfigurationGetParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('device.config.update'),
			params: DeviceConfigurationUpdateParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('diagnostics.get'),
			params: EmptyParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('preview.start'),
			params: PreviewSetParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('preview.update'),
			params: PreviewSetParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('preview.stop'),
			params: EmptyParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('preview.getFrame'),
			params: EmptyParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('event.emit'),
			params: EventEmitParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('event.clear'),
			params: EventClearParamsSchema,
		},
		strict,
	),
	Type.Object(
		{
			jsonrpc: Type.Literal('2.0'),
			id: JsonRpcIdSchema,
			method: Type.Literal('event.transition'),
			params: EventTransitionParamsSchema,
		},
		strict,
	),
]);

export const InitializeResultSchema = Type.Object(
	{
		protocolVersion: Type.Literal(PROTOCOL_VERSION),
		daemonVersion: Type.String({ minLength: 1, maxLength: 64 }),
	},
	strict,
);
export const DaemonStatusResultSchema = Type.Object(
	{
		lifecycle: Type.Union([
			Type.Literal('starting'),
			Type.Literal('running'),
			Type.Literal('stopping'),
		]),
		currentState: SemanticStateSchema,
	},
	strict,
);
export const ConfigResultSchema = AgentGlowConfigSchema;
export const ConfigValidationResultSchema = Type.Object({ valid: Type.Literal(true) }, strict);
export const DeviceListResultSchema = Type.Object(
	{ devices: Type.Array(DeviceDescriptorSchema, { maxItems: 64 }) },
	strict,
);
export const DeviceConfigurationResultSchema = DeviceConfigurationSchema;
export const DiagnosticsResultSchema = Type.Object(
	{
		service: Type.Object(
			{
				entryPath: Type.String({ minLength: 1, maxLength: 4096 }),
				runtimePath: Type.String({ minLength: 1, maxLength: 4096 }),
			},
			strict,
		),
		backend: Type.Object(
			{
				id: Type.String({ minLength: 1, maxLength: 128 }),
				health: Type.String({ minLength: 1, maxLength: 64 }),
			},
			strict,
		),
		devices: Type.Array(
			Type.Object(
				{
					deviceId: DeviceDescriptorSchema.properties.id,
					enabled: Type.Boolean(),
					delivery: Type.Object(
						{
							active: Type.Boolean(),
							consecutiveFailures: Type.Integer({ minimum: 0 }),
							pending: Type.Boolean(),
							retryScheduled: Type.Boolean(),
						},
						strict,
					),
					status: Type.Union([
						Type.Literal('unknown'),
						Type.Literal('ok'),
						Type.Literal('degraded'),
						Type.Literal('error'),
					]),
					requested: Type.Optional(Type.Unknown()),
					applied: Type.Optional(Type.Unknown()),
					details: Type.Optional(Type.Unknown()),
					reason: Type.Optional(Type.String({ maxLength: 4096 })),
				},
				strict,
			),
			{ maxItems: 64 },
		),
	},
	strict,
);
export const EventEmitResultSchema = Type.Object(
	{
		accepted: Type.Literal(true),
		currentState: SemanticStateSchema,
	},
	strict,
);
export const EventClearResultSchema = Type.Object(
	{
		cleared: Type.Integer({ minimum: 0 }),
		currentState: SemanticStateSchema,
	},
	strict,
);
export const PreviewResultSchema = Type.Union([
	Type.Object({ active: Type.Literal(false) }, strict),
	Type.Object({ active: Type.Literal(true), state: PreviewStateSchema }, strict),
]);
export const PreviewFrameResultSchema = Type.Union([
	Type.Object({ active: Type.Literal(false) }, strict),
	Type.Object(
		{
			active: Type.Literal(true),
			state: PreviewStateSchema,
			effect: Type.Union([
				Type.Literal('static'),
				Type.Literal('breathe'),
				Type.Literal('pulse'),
			]),
			color: Type.String({ pattern: '^#[0-9A-F]{6}$' }),
			intensity: Type.Number({ minimum: 0, maximum: 1 }),
		},
		strict,
	),
]);

export type RpcRequest = Static<typeof RpcRequestSchema>;
export type DiagnosticsResult = Static<typeof DiagnosticsResultSchema>;
export type PreviewResult = Static<typeof PreviewResultSchema>;
export type PreviewFrameResult = Static<typeof PreviewFrameResultSchema>;
