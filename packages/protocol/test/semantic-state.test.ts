import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { SemanticStateSchema } from '../src/semantic-state.js';

describe('SemanticStateSchema', () => {
	it('accepts every supported semantic state', () => {
		const states = ['idle', 'working', 'waiting_permission', 'success', 'error', 'paused'];

		for (const state of states) {
			expect(Value.Check(SemanticStateSchema, state)).toBe(true);
		}
	});

	it('rejects unknown states', () => {
		expect(Value.Check(SemanticStateSchema, 'completed')).toBe(false);
	});
});
