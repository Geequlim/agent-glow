import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const HARDWARE_INDEPENDENT_PACKAGES = ['packages/protocol', 'packages/config', 'packages/core'];
const SOURCE_EXTENSIONS = new Set(['.json', '.ts', '.tsx', '.mts', '.cts']);
const FORBIDDEN_REFERENCES = [
	{ pattern: /@agent-glow\/backend-/u, description: 'production backend package' },
	{ pattern: /@homebridge\/dbus-native/u, description: 'D-Bus implementation library' },
	{ pattern: /xyz\.ljones/u, description: 'asusd D-Bus interface' },
	{ pattern: /\basusd\b/iu, description: 'asusd implementation detail' },
	{ pattern: /\bAura\b/u, description: 'Aura implementation detail' },
	{ pattern: /\bSlash\b/u, description: 'Slash implementation detail' },
];

const violations: string[] = [];

for (const packageRoot of HARDWARE_INDEPENDENT_PACKAGES) {
	for (const filePath of collectSourceFiles(packageRoot)) {
		const content = readFileSync(filePath, 'utf8');
		for (const reference of FORBIDDEN_REFERENCES) {
			if (reference.pattern.test(content)) {
				violations.push(`${filePath}: contains ${reference.description}`);
			}
		}
	}
}

if (violations.length > 0) {
	console.error('Hardware-independent architecture boundary violations:');
	for (const violation of violations) console.error(`- ${violation}`);
	process.exitCode = 1;
} else {
	console.log('Hardware-independent architecture boundaries are intact.');
}

function collectSourceFiles(root: string): readonly string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...collectSourceFiles(entryPath));
		else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
	}
	return files;
}
