import { Type, type Static } from '@sinclair/typebox';

export const SemanticStateSchema = Type.Union([
	Type.Literal('idle'),
	Type.Literal('working'),
	Type.Literal('tool_use'),
	Type.Literal('waiting_permission'),
	Type.Literal('success'),
	Type.Literal('error'),
	Type.Literal('paused'),
]);

export type SemanticState = Static<typeof SemanticStateSchema>;
