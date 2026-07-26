import { describe, expect, it } from 'vitest';

import { getSemanticVisualEffect, renderVisualFrame } from '../src/semantic-visual-state.js';

describe('semantic visual effects', () => {
	it('uses explicit low static intensity for idle', () => {
		const effect = getSemanticVisualEffect('idle');

		expect(effect).toMatchObject({ effect: 'static', intensity: 0.25 });
		expect(renderVisualFrame(effect, 1000).intensity).toBe(0.25);
	});

	it('renders a continuous working breathe cycle', () => {
		const effect = getSemanticVisualEffect('working');
		if (effect.effect !== 'breathe') throw new Error('working must breathe');

		expect(renderVisualFrame(effect, 0).intensity).toBeCloseTo(0.08);
		expect(renderVisualFrame(effect, effect.periodMs / 2).intensity).toBeCloseTo(1);
		expect(renderVisualFrame(effect, effect.periodMs).intensity).toBeCloseTo(0.08);
	});

	it('uses a faster breathe period while waiting for permission', () => {
		const working = getSemanticVisualEffect('working');
		const waiting = getSemanticVisualEffect('waiting_permission');
		if (working.effect !== 'breathe' || waiting.effect !== 'breathe') {
			throw new Error('working and waiting_permission must breathe');
		}

		expect(waiting.periodMs).toBeLessThan(working.periodMs);
		expect(waiting.minimumIntensity).toBeLessThan(waiting.maximumIntensity);
	});
});
