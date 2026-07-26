import type { AgentGlowEvent } from '@agent-glow/protocol/event';
import type { SemanticState } from '@agent-glow/protocol/semantic-state';

import { selectHighestPriorityState } from './state-priority.js';

export const DEFAULT_PULSE_TTL_MS = 1500;

export interface MonotonicClock {
	now(): number;
}

interface Lease {
	readonly expiresAt?: number;
	readonly source: string;
	readonly sessionId: string;
	readonly state: SemanticState;
}

const systemClock: MonotonicClock = {
	now: () => performance.now(),
};

export class LeaseArbiter {
	readonly #clock: MonotonicClock;
	readonly #leases = new Map<string, Lease>();

	constructor(clock: MonotonicClock = systemClock) {
		this.#clock = clock;
	}

	apply(event: AgentGlowEvent): SemanticState {
		this.#removeExpired();
		const key = leaseKey(event.source, event.sessionId, event.state);

		if (event.phase === 'leave') {
			this.#leases.delete(key);
		} else {
			const ttlMs =
				event.ttlMs ?? (event.phase === 'pulse' ? DEFAULT_PULSE_TTL_MS : undefined);
			this.#leases.set(key, {
				source: event.source,
				sessionId: event.sessionId,
				state: event.state,
				expiresAt: ttlMs === undefined ? undefined : this.#clock.now() + ttlMs,
			});
		}

		return this.currentState();
	}

	clear(source: string, sessionId: string, state?: SemanticState): number {
		this.#removeExpired();
		let cleared = 0;

		for (const [key, lease] of this.#leases) {
			if (
				lease.source === source &&
				lease.sessionId === sessionId &&
				(state === undefined || lease.state === state)
			) {
				this.#leases.delete(key);
				cleared += 1;
			}
		}

		return cleared;
	}

	currentState(): SemanticState {
		this.#removeExpired();
		return selectHighestPriorityState([...this.#leases.values()].map((lease) => lease.state));
	}

	#removeExpired(): void {
		const now = this.#clock.now();
		for (const [key, lease] of this.#leases) {
			if (lease.expiresAt !== undefined && lease.expiresAt <= now) this.#leases.delete(key);
		}
	}
}

function leaseKey(source: string, sessionId: string, state: SemanticState): string {
	return JSON.stringify([source, sessionId, state]);
}
