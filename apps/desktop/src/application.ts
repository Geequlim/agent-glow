export interface DesktopWindow {
	present(): void;
}

export interface DesktopApplication {
	createWindow(): DesktopWindow;
	getActiveWindow(): DesktopWindow | undefined;
	onActivate(listener: () => void): void;
	run(args: readonly string[]): number;
}

export type DesktopApplicationFactory = () => DesktopApplication;

export function runDesktopApplication(createApplication: DesktopApplicationFactory): number {
	const application = createApplication();
	application.onActivate(() => {
		const activeWindow = application.getActiveWindow();
		if (activeWindow) {
			activeWindow.present();
			return;
		}
		application.createWindow().present();
	});
	return application.run([]);
}
