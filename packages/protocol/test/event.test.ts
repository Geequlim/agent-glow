import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { AgentGlowEventSchema } from '../src/event.js';
import { PROTOCOL_LIMITS } from '../src/limits.js';

const validEvent = {
	version: 1,
	source: 'codex',
	sessionId: 'session-1',
	state: 'working',
	phase: 'enter',
	metadata: { task: 'build' },
} as const;

describe('AgentGlowEventSchema', () => {
	it('accepts a bounded hardware-independent event', () => {
		expect(Value.Check(AgentGlowEventSchema, validEvent)).toBe(true);
	});

	it('rejects unknown fields and oversized input', () => {
		expect(Value.Check(AgentGlowEventSchema, { ...validEvent, deviceCommand: 'red' })).toBe(
			false,
		);
		expect(
			Value.Check(AgentGlowEventSchema, {
				...validEvent,
				source: 's'.repeat(PROTOCOL_LIMITS.maxSourceLength + 1),
			}),
		).toBe(false);
	});

	it('limits metadata entry count', () => {
		const metadata = Object.fromEntries(
			Array.from({ length: PROTOCOL_LIMITS.maxMetadataEntries + 1 }, (_, index) => [
				`key-${index}`,
				'value',
			]),
		);

		expect(Value.Check(AgentGlowEventSchema, { ...validEvent, metadata })).toBe(false);
	});
});
