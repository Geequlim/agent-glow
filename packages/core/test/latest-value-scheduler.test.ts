import { describe, expect, it } from 'vitest';

import {
	LatestValueScheduler,
	type SchedulerClock,
	staticVisualStateFingerprint,
} from '../src/latest-value-scheduler.js';

class FakeClock implements SchedulerClock {
	nowValue = 0;
	readonly timers: Array<{ callback: () => void; dueAt: number; timer: object }> = [];

	now(): number {
		return this.nowValue;
	}

	setTimer(callback: () => void, delayMs: number): unknown {
		const timer = {};
		this.timers.push({ callback, dueAt: this.nowValue + delayMs, timer });
		return timer;
	}

	clearTimer(timer: unknown): void {
		const index = this.timers.findIndex((candidate) => candidate.timer === timer);
		if (index >= 0) this.timers.splice(index, 1);
	}

	advance(milliseconds: number): void {
		this.nowValue += milliseconds;
		for (const timer of [...this.timers]) {
			if (timer.dueAt > this.nowValue) continue;
			this.clearTimer(timer.timer);
			timer.callback();
		}
	}
}

describe('LatestValueScheduler', () => {
	it('serializes a device and retains only the latest waiting value', async () => {
		const commits: number[] = [];
		const gates: Array<() => void> = [];
		let active = 0;
		let maximumActive = 0;
		const scheduler = new LatestValueScheduler<string, number, number>({
			fingerprint: String,
			commit: async (_key, value) => {
				commits.push(value);
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise<void>((resolve) => gates.push(resolve));
				active -= 1;
				return value;
			},
		});

		scheduler.submit('device-1', 1);
		scheduler.submit('device-1', 2);
		scheduler.submit('device-1', 3);
		await tick();
		expect(commits).toEqual([1]);
		gates.shift()?.();
		await tick();
		expect(commits).toEqual([1, 3]);
		gates.shift()?.();
		await scheduler.flush();

		expect(maximumActive).toBe(1);
	});

	it('deduplicates equal successful values', async () => {
		let commits = 0;
		const scheduler = new LatestValueScheduler<string, number, void>({
			fingerprint: String,
			commit: async () => {
				commits += 1;
			},
		});

		scheduler.submit('device-1', 1);
		await scheduler.flush();
		scheduler.submit('device-1', 1);
		await scheduler.flush();

		expect(commits).toBe(1);
	});

	it('retries with bounded exponential backoff', async () => {
		const clock = new FakeClock();
		const delays: number[] = [];
		let attempts = 0;
		const scheduler = new LatestValueScheduler<string, number, void>({
			clock,
			fingerprint: String,
			retryBaseDelayMs: 100,
			maximumRetryDelayMs: 150,
			onError: (_key, _error, _failures, delay) => delays.push(delay),
			commit: async () => {
				attempts += 1;
				if (attempts < 3) throw new Error('slow device');
			},
		});

		scheduler.submit('device-1', 1);
		await tick();
		expect(attempts).toBe(1);
		clock.advance(100);
		await tick();
		expect(attempts).toBe(2);
		clock.advance(150);
		await scheduler.flush();

		expect(attempts).toBe(3);
		expect(delays).toEqual([100, 150]);
	});

	it('fingerprints only quantized hardware output', () => {
		const base = {
			color: { red: 100, green: 50, blue: 25 },
			hardwareIntensity: 0.5,
			intensity: 0.5,
			semanticState: 'working',
		} as const;

		expect(staticVisualStateFingerprint(base)).toBe(
			staticVisualStateFingerprint({
				...base,
				intensity: 0.500_1,
			}),
		);
	});

	it('pauses without dropping the latest pending value', async () => {
		const commits: number[] = [];
		const scheduler = new LatestValueScheduler<string, number, void>({
			fingerprint: String,
			commit: async (_key, value) => {
				commits.push(value);
			},
		});

		await scheduler.pause();
		scheduler.submit('device-1', 1);
		scheduler.submit('device-1', 2);
		expect(commits).toEqual([]);
		scheduler.resume();
		await scheduler.flush();

		expect(commits).toEqual([2]);
	});

	it('keeps a healthy device moving while another device is backing off', async () => {
		const clock = new FakeClock();
		const commits: string[] = [];
		const scheduler = new LatestValueScheduler<string, number, void>({
			clock,
			fingerprint: String,
			commit: async (key) => {
				commits.push(key);
				if (key === 'broken') throw new Error('device unavailable');
			},
		});

		scheduler.submit('broken', 1);
		scheduler.submit('healthy', 1);
		await tick();

		expect(commits).toContain('broken');
		expect(commits).toContain('healthy');
		scheduler.submit('healthy', 2);
		await scheduler.flush();
		expect(commits.filter((key) => key === 'healthy')).toHaveLength(2);
		await scheduler.close();
	});

	it('does not leave a retry timer when an active commit fails during close', async () => {
		const clock = new FakeClock();
		let rejectCommit: ((error: Error) => void) | undefined;
		const scheduler = new LatestValueScheduler<string, number, void>({
			clock,
			fingerprint: String,
			commit: () =>
				new Promise<void>((_resolve, reject) => {
					rejectCommit = reject;
				}),
		});
		scheduler.submit('device-1', 1);
		await tick();

		const closing = scheduler.close();
		rejectCommit?.(new Error('closed device'));
		await closing;

		expect(clock.timers).toEqual([]);
	});
});

async function tick(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
