import { describe, expect, it, vi } from 'vitest';

import {
	runDesktopApplication,
	type DesktopApplication,
	type DesktopWindow,
} from '../src/application.js';

describe('runDesktopApplication', () => {
	it('creates one window and reuses it on a later activation', () => {
		let activate: (() => void) | undefined;
		let activeWindow: DesktopWindow | undefined;
		const window = { present: vi.fn() };
		const application: DesktopApplication = {
			createWindow: vi.fn(() => {
				activeWindow = window;
				return window;
			}),
			getActiveWindow: () => activeWindow,
			onActivate: (listener) => {
				activate = listener;
			},
			run: vi.fn(() => {
				activate?.();
				activate?.();
				return 0;
			}),
		};

		expect(runDesktopApplication(() => application)).toBe(0);
		expect(application.createWindow).toHaveBeenCalledOnce();
		expect(window.present).toHaveBeenCalledTimes(2);
		expect(application.run).toHaveBeenCalledWith([]);
	});
});
