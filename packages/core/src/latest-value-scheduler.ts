import type { StaticVisualState } from './backend.js';
import { quantizeColor, quantizeUnit } from './color-space.js';

export interface SchedulerClock {
	clearTimer(timer: unknown): void;
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
}

export interface LatestValueSchedulerOptions<Key, Value, Result> {
	readonly clock?: SchedulerClock;
	readonly commit: (key: Key, value: Value) => Promise<Result>;
	readonly fingerprint: (value: Value) => string;
	readonly maximumRetryDelayMs?: number;
	readonly onError?: (
		key: Key,
		error: unknown,
		consecutiveFailures: number,
		retryDelayMs: number,
	) => void;
	readonly onResult?: (key: Key, result: Result) => void;
	readonly retryBaseDelayMs?: number;
}

interface Entry<Value> {
	active: boolean;
	consecutiveFailures: number;
	hasPending: boolean;
	lastFingerprint?: string;
	pending?: Value;
	retryTimer?: unknown;
}

const systemClock: SchedulerClock = {
	now: () => performance.now(),
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class LatestValueScheduler<Key, Value, Result> {
	readonly #clock: SchedulerClock;
	readonly #commit: LatestValueSchedulerOptions<Key, Value, Result>['commit'];
	readonly #entries = new Map<Key, Entry<Value>>();
	readonly #fingerprint: LatestValueSchedulerOptions<Key, Value, Result>['fingerprint'];
	readonly #maximumRetryDelayMs: number;
	readonly #onError: LatestValueSchedulerOptions<Key, Value, Result>['onError'];
	readonly #onResult: LatestValueSchedulerOptions<Key, Value, Result>['onResult'];
	readonly #retryBaseDelayMs: number;
	readonly #settledWaiters = new Set<() => void>();
	#closed = false;
	#paused = false;

	constructor(options: LatestValueSchedulerOptions<Key, Value, Result>) {
		this.#clock = options.clock ?? systemClock;
		this.#commit = options.commit;
		this.#fingerprint = options.fingerprint;
		this.#maximumRetryDelayMs = options.maximumRetryDelayMs ?? 5000;
		this.#onError = options.onError;
		this.#onResult = options.onResult;
		this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
	}

	submit(key: Key, value: Value): void {
		if (this.#closed) return;
		const entry = this.#entry(key);
		entry.pending = value;
		entry.hasPending = true;
		void this.#drain(key, entry);
	}

	invalidate(key?: Key): void {
		if (key === undefined) {
			for (const entry of this.#entries.values()) entry.lastFingerprint = undefined;
			return;
		}
		const entry = this.#entries.get(key);
		if (entry) entry.lastFingerprint = undefined;
	}

	async pause(): Promise<void> {
		this.#paused = true;
		for (const entry of this.#entries.values()) {
			if (entry.retryTimer !== undefined) {
				this.#clock.clearTimer(entry.retryTimer);
				entry.retryTimer = undefined;
			}
		}
		await this.flush();
	}

	resume(): void {
		if (this.#closed) return;
		this.#paused = false;
		for (const [key, entry] of this.#entries) void this.#drain(key, entry);
	}

	async flush(): Promise<void> {
		if (this.#isSettled()) return;
		await new Promise<void>((resolve) => this.#settledWaiters.add(resolve));
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const entry of this.#entries.values()) {
			entry.hasPending = false;
			entry.pending = undefined;
			if (entry.retryTimer !== undefined) {
				this.#clock.clearTimer(entry.retryTimer);
				entry.retryTimer = undefined;
			}
		}
		await this.flush();
	}

	async #drain(key: Key, entry: Entry<Value>): Promise<void> {
		if (
			this.#closed ||
			this.#paused ||
			entry.active ||
			entry.retryTimer !== undefined ||
			!entry.hasPending
		) {
			this.#notifyIfSettled();
			return;
		}

		const value = entry.pending as Value;
		const fingerprint = this.#fingerprint(value);
		entry.pending = undefined;
		entry.hasPending = false;
		if (fingerprint === entry.lastFingerprint) {
			this.#notifyIfSettled();
			return;
		}

		entry.active = true;
		try {
			const result = await this.#commit(key, value);
			entry.lastFingerprint = fingerprint;
			entry.consecutiveFailures = 0;
			this.#onResult?.(key, result);
		} catch (error) {
			entry.consecutiveFailures += 1;
			const retryDelayMs = Math.min(
				this.#maximumRetryDelayMs,
				this.#retryBaseDelayMs * 2 ** (entry.consecutiveFailures - 1),
			);
			if (!this.#closed) {
				if (!entry.hasPending) {
					entry.pending = value;
					entry.hasPending = true;
				}
				this.#onError?.(key, error, entry.consecutiveFailures, retryDelayMs);
			}
			if (!this.#closed && !this.#paused) {
				entry.retryTimer = this.#clock.setTimer(() => {
					entry.retryTimer = undefined;
					void this.#drain(key, entry);
				}, retryDelayMs);
			}
		} finally {
			entry.active = false;
			if (entry.retryTimer === undefined) void this.#drain(key, entry);
			this.#notifyIfSettled();
		}
	}

	#entry(key: Key): Entry<Value> {
		let entry = this.#entries.get(key);
		if (!entry) {
			entry = { active: false, consecutiveFailures: 0, hasPending: false };
			this.#entries.set(key, entry);
		}
		return entry;
	}

	#isSettled(): boolean {
		for (const entry of this.#entries.values()) {
			if (this.#paused && !entry.active) continue;
			if (entry.active || (entry.hasPending && entry.retryTimer === undefined)) return false;
		}
		return true;
	}

	#notifyIfSettled(): void {
		if (!this.#isSettled()) return;
		for (const resolve of this.#settledWaiters) resolve();
		this.#settledWaiters.clear();
	}
}

export function staticVisualStateFingerprint(state: StaticVisualState): string {
	const color = quantizeColor({
		red: state.color.red * state.intensity,
		green: state.color.green * state.intensity,
		blue: state.color.blue * state.intensity,
	});
	return [
		state.semanticState,
		color.red,
		color.green,
		color.blue,
		quantizeUnit(state.hardwareIntensity),
	].join(':');
}
