import { describe, expect, it } from 'vitest';

import type { MonotonicClock } from '../src/lease-arbiter.js';
import { getSemanticVisualEffect, renderVisualFrame } from '../src/semantic-visual-state.js';
import { VisualStateEngine } from '../src/visual-state-engine.js';

class FakeClock implements MonotonicClock {
	nowValue = 0;

	now(): number {
		return this.nowValue;
	}
}

describe('VisualStateEngine', () => {
	it('starts a transition from the exact frame visible during redirection', () => {
		const clock = new FakeClock();
		const engine = new VisualStateEngine(getSemanticVisualEffect('idle'), clock, 300);
		engine.setTarget(getSemanticVisualEffect('working'));
		clock.nowValue = 150;
		const beforeRedirect = engine.frame();

		engine.setTarget(getSemanticVisualEffect('error'));
		const afterRedirect = engine.frame();

		expect(afterRedirect.color).toEqual(beforeRedirect.color);
		expect(afterRedirect.intensity).toBe(beforeRedirect.intensity);
	});

	it('finishes at the target frame while its breathe phase keeps advancing', () => {
		const clock = new FakeClock();
		const engine = new VisualStateEngine(getSemanticVisualEffect('idle'), clock, 300);
		engine.setTarget(getSemanticVisualEffect('working'));
		clock.nowValue = 300;

		expect(engine.frame().intensity).toBeGreaterThan(0.08);
		expect(engine.isAnimating()).toBe(true);
	});

	it('reports a completed one-shot pulse as no longer animating', () => {
		const clock = new FakeClock();
		const engine = new VisualStateEngine(getSemanticVisualEffect('success'), clock, 300);
		clock.nowValue = 901;

		expect(engine.isAnimating()).toBe(false);
	});

	it('reconfigures from the visible frame without restarting the effect timeline', () => {
		const clock = new FakeClock();
		const original = getSemanticVisualEffect('working');
		if (original.effect !== 'breathe') throw new Error('Working fixture must breathe');
		const engine = new VisualStateEngine(original, clock, 300);
		clock.nowValue = original.periodMs / 2;
		const before = engine.frame();
		const updated = {
			...original,
			color: { red: 255, green: 0, blue: 0 },
		};

		engine.reconfigure(updated, 300);
		const after = engine.frame();
		clock.nowValue += 300;
		const completed = engine.frame();
		const expected = renderVisualFrame(updated, clock.nowValue);

		expect(after.color.red).toBeCloseTo(before.color.red);
		expect(after.color.green).toBeCloseTo(before.color.green);
		expect(after.color.blue).toBeCloseTo(before.color.blue);
		expect(after.intensity).toBe(before.intensity);
		expect(completed.color.red).toBe(255);
		expect(completed.intensity).toBeCloseTo(expected.intensity);
	});
});
