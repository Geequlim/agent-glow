import * as gi from 'node-gtk';

import type { DesktopApplication } from './application.js';

const Adw = gi.require('Adw', '1');
const Gio = gi.require('Gio', '2.0');

const APPLICATION_ID = 'io.github.geequlim.AgentGlow';

export function createGtkApplication(): DesktopApplication {
	const application = new Adw.Application({
		applicationId: APPLICATION_ID,
		flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
	});
	return {
		onActivate: (listener) => application.on('activate', listener),
		getActiveWindow: () => application.getActiveWindow() ?? undefined,
		createWindow: () =>
			new Adw.ApplicationWindow({
				application,
				defaultWidth: 720,
				defaultHeight: 480,
				title: 'AgentGlow',
			}),
		run: (args) => application.run([...args]),
	};
}
