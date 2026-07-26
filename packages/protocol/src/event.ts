import { Type, type Static } from '@sinclair/typebox';

import { PROTOCOL_LIMITS, PROTOCOL_VERSION } from './limits.js';
import { SemanticStateSchema } from './semantic-state.js';

const strict = { additionalProperties: false } as const;

export const EventPhaseSchema = Type.Union([
	Type.Literal('enter'),
	Type.Literal('leave'),
	Type.Literal('pulse'),
]);

export const AgentGlowEventSchema = Type.Object(
	{
		version: Type.Literal(PROTOCOL_VERSION),
		source: Type.String({ minLength: 1, maxLength: PROTOCOL_LIMITS.maxSourceLength }),
		sessionId: Type.String({
			minLength: 1,
			maxLength: PROTOCOL_LIMITS.maxSessionIdLength,
		}),
		state: SemanticStateSchema,
		phase: EventPhaseSchema,
		timestamp: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		ttlMs: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: PROTOCOL_LIMITS.maxTtlMs,
			}),
		),
		metadata: Type.Optional(
			Type.Record(
				Type.String({
					minLength: 1,
					maxLength: PROTOCOL_LIMITS.maxMetadataKeyLength,
				}),
				Type.String({ maxLength: PROTOCOL_LIMITS.maxMetadataValueLength }),
				{ maxProperties: PROTOCOL_LIMITS.maxMetadataEntries },
			),
		),
	},
	strict,
);

export type AgentGlowEvent = Static<typeof AgentGlowEventSchema>;
export type EventPhase = Static<typeof EventPhaseSchema>;
