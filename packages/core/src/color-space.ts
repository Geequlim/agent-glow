import type { RgbColor } from './backend.js';

export function srgbChannelToLinear(channel: number): number {
	const normalized = clamp(channel / 255, 0, 1);
	return normalized <= 0.040_45 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function linearChannelToSrgb(channel: number): number {
	const normalized = clamp(channel, 0, 1);
	const srgb =
		normalized <= 0.003_130_8 ? normalized * 12.92 : 1.055 * normalized ** (1 / 2.4) - 0.055;
	return srgb * 255;
}

export function interpolateColorLinear(from: RgbColor, to: RgbColor, progress: number): RgbColor {
	const amount = clamp(progress, 0, 1);
	return {
		red: interpolateChannel(from.red, to.red, amount),
		green: interpolateChannel(from.green, to.green, amount),
		blue: interpolateChannel(from.blue, to.blue, amount),
	};
}

export function quantizeColor(color: RgbColor): RgbColor {
	return {
		red: quantizeChannel(color.red),
		green: quantizeChannel(color.green),
		blue: quantizeChannel(color.blue),
	};
}

export function quantizeUnit(value: number): number {
	return Math.round(clamp(value, 0, 1) * 255) / 255;
}

export function easeInOutCubic(progress: number): number {
	const amount = clamp(progress, 0, 1);
	return amount < 0.5 ? 4 * amount ** 3 : 1 - (-2 * amount + 2) ** 3 / 2;
}

function interpolateChannel(from: number, to: number, progress: number): number {
	const linear =
		srgbChannelToLinear(from) +
		(srgbChannelToLinear(to) - srgbChannelToLinear(from)) * progress;
	return linearChannelToSrgb(linear);
}

function quantizeChannel(channel: number): number {
	return Math.round(clamp(channel, 0, 255));
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}
