import { describe, expect, it } from 'vitest';

import {
	easeInOutCubic,
	interpolateColorLinear,
	linearChannelToSrgb,
	quantizeColor,
	quantizeUnit,
	srgbChannelToLinear,
} from '../src/color-space.js';

describe('color space primitives', () => {
	it('round-trips sRGB channels through linear space', () => {
		for (const channel of [0, 1, 32, 128, 254, 255]) {
			expect(linearChannelToSrgb(srgbChannelToLinear(channel))).toBeCloseTo(channel, 8);
		}
	});

	it('interpolates light in linear RGB rather than sRGB bytes', () => {
		const midpoint = interpolateColorLinear(
			{ red: 0, green: 0, blue: 0 },
			{ red: 255, green: 255, blue: 255 },
			0.5,
		);

		expect(midpoint.red).toBeGreaterThan(180);
		expect(midpoint.red).toBeLessThan(190);
	});

	it('preserves exact colors at interpolation boundaries', () => {
		const from = { red: 55, green: 48, blue: 255 };
		const to = { red: 88, green: 112, blue: 254 };

		expect(interpolateColorLinear(from, to, 0)).toBe(from);
		expect(interpolateColorLinear(from, to, 1)).toBe(to);
	});

	it('quantizes channels and unit values to stable 8-bit steps', () => {
		expect(quantizeColor({ red: 1.4, green: 254.6, blue: 300 })).toEqual({
			red: 1,
			green: 255,
			blue: 255,
		});
		expect(quantizeUnit(0.5)).toBe(128 / 255);
	});

	it('clamps easing at both ends', () => {
		expect(easeInOutCubic(-1)).toBe(0);
		expect(easeInOutCubic(0.5)).toBe(0.5);
		expect(easeInOutCubic(2)).toBe(1);
	});
});
