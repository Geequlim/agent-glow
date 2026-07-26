import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLICATION_ID = 'io.github.geequlim.AgentGlow';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopBundle = path.join(repositoryRoot, 'apps', 'desktop', 'dist', 'index.cjs');
const iconPath = path.join(repositoryRoot, 'apps', 'desktop', 'icon.png');
const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share');
const applicationsDirectory = path.join(dataHome, 'applications');
const desktopEntryPath = path.join(applicationsDirectory, `${APPLICATION_ID}.desktop`);
const action = process.argv[2] ?? 'install';

if (action === 'remove') {
	await unlink(desktopEntryPath).catch((error: unknown) => {
		if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
	});
	console.log(`[agent-glow] removed development desktop entry: ${desktopEntryPath}`);
} else if (action === 'install') {
	await Promise.all([access(desktopBundle), access(iconPath)]);
	await mkdir(applicationsDirectory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${desktopEntryPath}.tmp-${process.pid}`;
	await writeFile(temporaryPath, createDesktopEntry(process.execPath, desktopBundle, iconPath), {
		encoding: 'utf8',
		mode: 0o644,
	});
	await rename(temporaryPath, desktopEntryPath);
	console.log(`[agent-glow] installed development desktop entry: ${desktopEntryPath}`);
} else {
	throw new Error('用法：node scripts/install-dev-desktop-entry.mts [install|remove]');
}

function createDesktopEntry(nodePath: string, bundlePath: string, applicationIcon: string): string {
	return `[Desktop Entry]
Type=Application
Name=AgentGlow
Comment=Display Agent activity through hardware lighting
Exec=${quoteDesktopArgument(nodePath)} --enable-source-maps ${quoteDesktopArgument(bundlePath)}
Icon=${applicationIcon}
Terminal=false
Categories=Settings;
StartupNotify=true
StartupWMClass=${APPLICATION_ID}
DBusActivatable=false
`;
}

function quoteDesktopArgument(value: string): string {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
