import type { AgentGlowEvent } from '@agent-glow/protocol/event';
import { describe, expect, it } from 'vitest';

import {
	DEFAULT_PULSE_TTL_MS,
	DEFAULT_STALE_LEASE_TTL_MS,
	LeaseArbiter,
	type MonotonicClock,
} from '../src/lease-arbiter.js';

class FakeClock implements MonotonicClock {
	#now = 0;

	now(): number {
		return this.#now;
	}

	advance(milliseconds: number): void {
		this.#now += milliseconds;
	}
}

describe('LeaseArbiter', () => {
	it('restores a lower-priority state after leave', () => {
		const arbiter = new LeaseArbiter();

		expect(arbiter.apply(event('working', 'enter'))).toBe('working');
		expect(arbiter.apply(event('waiting_permission', 'enter'))).toBe('waiting_permission');
		expect(arbiter.apply(event('waiting_permission', 'leave'))).toBe('working');
	});

	it('expires a pulse using the injected monotonic clock', () => {
		const clock = new FakeClock();
		const arbiter = new LeaseArbiter(clock);

		arbiter.apply(event('working', 'enter'));
		expect(arbiter.apply(event('success', 'pulse'))).toBe('success');

		clock.advance(DEFAULT_PULSE_TTL_MS);

		expect(arbiter.currentState()).toBe('working');
	});

	it('keeps another session active when one session is cleared', () => {
		const arbiter = new LeaseArbiter();
		arbiter.apply(event('working', 'enter', 'session-1'));
		arbiter.apply(event('error', 'enter', 'session-2'));

		expect(arbiter.clear('codex', 'session-2')).toBe(1);
		expect(arbiter.currentState()).toBe('working');
	});

	it('expires a continuous lease with an explicit TTL', () => {
		const clock = new FakeClock();
		const arbiter = new LeaseArbiter(clock);
		arbiter.apply({ ...event('working', 'enter'), ttlMs: 10 });

		clock.advance(10);

		expect(arbiter.currentState()).toBe('idle');
	});

	it('reclaims an enter lease after the default stale timeout', () => {
		const clock = new FakeClock();
		const arbiter = new LeaseArbiter(clock);
		arbiter.apply(event('working', 'enter'));

		clock.advance(DEFAULT_STALE_LEASE_TTL_MS);

		expect(arbiter.currentState()).toBe('idle');
	});
});

function event(
	state: AgentGlowEvent['state'],
	phase: AgentGlowEvent['phase'],
	sessionId = 'session-1',
): AgentGlowEvent {
	return {
		version: 1,
		source: 'codex',
		sessionId,
		state,
		phase,
	};
}
