import { describe, expect, it } from 'vitest';

import { getSemanticVisualEffect, renderVisualFrame } from '../src/semantic-visual-state.js';

describe('semantic visual effects', () => {
	it('uses an off frame only as the idle restoration fallback', () => {
		const effect = getSemanticVisualEffect('idle');

		expect(effect).toMatchObject({
			color: { red: 0, green: 0, blue: 0 },
			effect: 'static',
			hardwareIntensity: 0,
			intensity: 0,
		});
		expect(renderVisualFrame(effect, 1000).intensity).toBe(0);
	});

	it('renders a continuous working breathe cycle', () => {
		const effect = getSemanticVisualEffect('working');
		if (effect.effect !== 'breathe') throw new Error('working must breathe');

		expect(renderVisualFrame(effect, 0).intensity).toBeCloseTo(effect.minimumIntensity);
		expect(renderVisualFrame(effect, effect.periodMs / 2).intensity).toBeCloseTo(
			effect.maximumIntensity,
		);
		expect(renderVisualFrame(effect, effect.periodMs).intensity).toBeCloseTo(
			effect.minimumIntensity,
		);
	});

	it('interpolates animated colors with the effect progress', () => {
		const effect = {
			effect: 'breathe',
			startColor: { red: 0, green: 0, blue: 0 },
			endColor: { red: 255, green: 128, blue: 64 },
			hardwareIntensity: 1,
			minimumIntensity: 0.1,
			maximumIntensity: 1,
			periodMs: 1000,
			semanticState: 'working',
		} as const;

		expect(renderVisualFrame(effect, 0).color).toEqual(effect.startColor);
		expect(renderVisualFrame(effect, 500).color.red).toBeCloseTo(effect.endColor.red);
		expect(renderVisualFrame(effect, 500).color.green).toBeCloseTo(effect.endColor.green);
		expect(renderVisualFrame(effect, 500).color.blue).toBeCloseTo(effect.endColor.blue);
		expect(renderVisualFrame(effect, 1000).color).toEqual(effect.startColor);
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

	it('renders tool use as a continuous asymmetric stream', () => {
		const effect = getSemanticVisualEffect('tool_use');
		if (effect.effect !== 'stream') throw new Error('tool_use must stream');

		const initial = renderVisualFrame(effect, 0);
		const faded = renderVisualFrame(effect, effect.periodMs * 0.65);
		const rising = renderVisualFrame(effect, effect.periodMs * 0.9);
		const nextCycle = renderVisualFrame(effect, effect.periodMs);

		expect(initial.color).toEqual(effect.endColor);
		expect(initial.intensity).toBeCloseTo(effect.maximumIntensity);
		expect(faded.color).toEqual(effect.startColor);
		expect(faded.intensity).toBeCloseTo(effect.minimumIntensity);
		expect(rising.intensity).toBeGreaterThan(effect.minimumIntensity);
		expect(rising.intensity).toBeLessThan(effect.maximumIntensity);
		expect(nextCycle).toEqual(initial);
	});

	it('renders success as two green peaks that settle on low Codex blue', () => {
		const success = getSemanticVisualEffect('success');
		if (success.effect !== 'pulse') throw new Error('success must pulse');

		const firstPeak = renderVisualFrame(success, success.durationMs / 4);
		const secondPeak = renderVisualFrame(success, (success.durationMs * 3) / 4);
		const completed = renderVisualFrame(success, success.durationMs);

		expect(firstPeak.color).toEqual(success.endColor);
		expect(firstPeak.intensity).toBeCloseTo(success.maximumIntensity);
		expect(secondPeak.color).toEqual(success.endColor);
		expect(secondPeak.intensity).toBeCloseTo(success.maximumIntensity);
		expect(completed.color.red).toBeCloseTo(success.startColor.red);
		expect(completed.color.green).toBeCloseTo(success.startColor.green);
		expect(completed.color.blue).toBeCloseTo(success.startColor.blue);
		expect(completed.intensity).toBeCloseTo(success.minimumIntensity);
	});

	it('renders error as two full pulses', () => {
		const error = getSemanticVisualEffect('error');
		if (error.effect !== 'pulse') throw new Error('error must pulse');

		expect(renderVisualFrame(error, error.durationMs / 4).intensity).toBeCloseTo(1);
		expect(renderVisualFrame(error, (error.durationMs * 3) / 4).intensity).toBeCloseTo(1);
	});
});
