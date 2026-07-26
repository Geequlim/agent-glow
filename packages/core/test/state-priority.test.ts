import { describe, expect, it } from 'vitest';

import { selectHighestPriorityState } from '../src/state-priority.js';

describe('selectHighestPriorityState', () => {
	it('returns idle when there are no active states', () => {
		expect(selectHighestPriorityState([])).toBe('idle');
	});

	it('uses the priority defined by the technical plan', () => {
		expect(selectHighestPriorityState(['working', 'paused', 'success'])).toBe('success');
		expect(selectHighestPriorityState(['error', 'waiting_permission'])).toBe('error');
	});
});
