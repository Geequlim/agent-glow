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

	it('produces several visible intermediate frames at the default cadence', () => {
		const clock = new FakeClock();
		const paused = getSemanticVisualEffect('paused');
		if (paused.effect !== 'static') throw new Error('Paused fixture must be static');
		const engine = new VisualStateEngine(getSemanticVisualEffect('idle'), clock, 300);
		engine.setTarget(paused);

		const intensities = [67, 133, 200, 267].map((time) => {
			clock.nowValue = time;
			return engine.frame().intensity;
		});

		expect(intensities).toEqual([...intensities].sort((left, right) => left - right));
		expect(new Set(intensities.map((intensity) => intensity.toFixed(4))).size).toBe(4);
		expect(intensities[0]).toBeGreaterThan(0);
		expect(intensities.at(-1)).toBeLessThan(paused.intensity);
	});

	it('reports a completed one-shot pulse as no longer animating', () => {
		const clock = new FakeClock();
		const success = getSemanticVisualEffect('success');
		if (success.effect !== 'pulse') throw new Error('Success fixture must pulse');
		const engine = new VisualStateEngine(success, clock, 300);
		clock.nowValue = success.durationMs + 1;

		expect(engine.isAnimating()).toBe(false);
	});

	it('keeps a long tool stream active and restores working after a short call', () => {
		const clock = new FakeClock();
		const working = getSemanticVisualEffect('working');
		const toolUse = getSemanticVisualEffect('tool_use');
		const engine = new VisualStateEngine(working, clock, 120);

		engine.setTarget(toolUse);
		clock.nowValue = 200;
		const shortCallFrame = engine.frame();
		expect(shortCallFrame.semanticState).toBe('tool_use');
		expect(shortCallFrame.color).not.toEqual(renderVisualFrame(working, 200).color);

		clock.nowValue = 15_000;
		expect(engine.isAnimating()).toBe(true);
		expect(engine.frame().semanticState).toBe('tool_use');

		engine.setTarget(working);
		clock.nowValue += 120;
		expect(engine.frame().semanticState).toBe('working');
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
			startColor: { red: 255, green: 0, blue: 0 },
			endColor: { red: 255, green: 0, blue: 0 },
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
		expect(completed.color.red).toBeCloseTo(255);
		expect(completed.intensity).toBeCloseTo(expected.intensity);
	});
});
