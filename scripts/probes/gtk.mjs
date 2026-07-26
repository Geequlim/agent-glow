import * as gi from 'node-gtk';

const Adw = gi.require('Adw', '1');
const Gio = gi.require('Gio', '2.0');
const GLib = gi.require('GLib', '2.0');
const Gtk = gi.require('Gtk', '4.0');

console.log(
	JSON.stringify(
		{
			node: process.version,
			gtk: `${Gtk.getMajorVersion()}.${Gtk.getMinorVersion()}.${Gtk.getMicroVersion()}`,
			libadwaita: `${Adw.getMajorVersion()}.${Adw.getMinorVersion()}.${Adw.getMicroVersion()}`,
			windowRequested: process.argv.includes('--window'),
		},
		null,
		2,
	),
);

if (process.argv.includes('--window')) {
	const application = new Adw.Application({
		applicationId: 'io.github.geequlim.AgentGlow.Probe',
		flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
	});

	application.on('activate', () => {
		const window = new Adw.ApplicationWindow({
			application,
			defaultWidth: 420,
			defaultHeight: 180,
			title: 'Agent Glow GTK Probe',
			content: new Gtk.Label({
				label: 'Node.js 24 + GTK4 + libadwaita 已成功加载',
			}),
		});
		window.present();
		GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 1500, () => {
			window.close();
			application.quit();
			return GLib.SOURCE_REMOVE;
		});
	});

	process.exitCode = application.run([]);
}
