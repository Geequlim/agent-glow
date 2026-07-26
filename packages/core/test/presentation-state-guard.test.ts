import { describe, expect, it } from 'vitest';

import type { MonotonicClock } from '../src/lease-arbiter.js';
import { PresentationStateGuard } from '../src/presentation-state-guard.js';

class FakeClock implements MonotonicClock {
	nowValue = 0;

	now(): number {
		return this.nowValue;
	}
}

describe('PresentationStateGuard', () => {
	it('keeps a short tool call visible before returning to the latest lower state', () => {
		const clock = new FakeClock();
		const guard = new PresentationStateGuard(() => 800, clock);

		expect(guard.select('working')).toBe('working');
		clock.nowValue = 800;
		expect(guard.select('tool_use')).toBe('tool_use');
		clock.nowValue = 850;
		expect(guard.select('working')).toBe('tool_use');
		clock.nowValue = 1599;
		expect(guard.select('idle')).toBe('tool_use');
		clock.nowValue = 1600;
		expect(guard.select('working')).toBe('working');
	});

	it('protects every displayed non-idle state without extending its deadline', () => {
		const clock = new FakeClock();
		const guard = new PresentationStateGuard(() => 800, clock);

		expect(guard.select('waiting_permission')).toBe('waiting_permission');
		clock.nowValue = 700;
		expect(guard.select('waiting_permission')).toBe('waiting_permission');
		expect(guard.select('error')).toBe('waiting_permission');
		clock.nowValue = 800;
		expect(guard.select('error')).toBe('error');
	});

	it('skips intermediate desired states and presents only the latest one', () => {
		const clock = new FakeClock();
		const guard = new PresentationStateGuard(() => 500, clock);

		expect(guard.select('working')).toBe('working');
		clock.nowValue = 100;
		expect(guard.select('tool_use')).toBe('working');
		clock.nowValue = 200;
		expect(guard.select('waiting_permission')).toBe('working');
		clock.nowValue = 300;
		expect(guard.select('success')).toBe('working');
		clock.nowValue = 500;
		expect(guard.select('success')).toBe('success');
	});

	it('allows a new visible state to start immediately from idle', () => {
		const clock = new FakeClock();
		const guard = new PresentationStateGuard(() => 800, clock);

		expect(guard.select('working')).toBe('working');
	});
});
