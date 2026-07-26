import { describe, expect, it } from 'vitest';

import type { MonotonicClock } from '../src/lease-arbiter.js';
import { getSemanticVisualEffect } from '../src/semantic-visual-state.js';
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
});
