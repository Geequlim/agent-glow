import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SysfsPowerSourceMonitor } from '../src/power-source-monitor.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe('SysfsPowerSourceMonitor', () => {
	it('reports battery mode only when a battery exists and external power is offline', async () => {
		const root = await createPowerSupplyTree();
		await addSupply(root, 'BAT0', { status: 'Discharging', type: 'Battery' });
		await addSupply(root, 'AC0', { online: '0', type: 'Mains' });
		const monitor = new SysfsPowerSourceMonitor(root);

		expect(await monitor.isOnBattery()).toBe(true);
		await writeFile(path.join(root, 'AC0', 'online'), '1\n');
		expect(await monitor.isOnBattery()).toBe(false);
	});

	it('does not treat a desktop without a battery as battery powered', async () => {
		const root = await createPowerSupplyTree();
		await addSupply(root, 'AC0', { online: '0', type: 'Mains' });

		expect(await new SysfsPowerSourceMonitor(root).isOnBattery()).toBe(false);
	});

	it('falls back to battery status when no external supply is exposed', async () => {
		const root = await createPowerSupplyTree();
		await addSupply(root, 'BAT0', { status: 'Discharging', type: 'Battery' });

		expect(await new SysfsPowerSourceMonitor(root).isOnBattery()).toBe(true);
	});

	it('reports power source changes while watching', async () => {
		const root = await createPowerSupplyTree();
		await addSupply(root, 'BAT0', { status: 'Discharging', type: 'Battery' });
		await addSupply(root, 'AC0', { online: '0', type: 'Mains' });
		const observed: boolean[] = [];
		const stop = new SysfsPowerSourceMonitor(root, 10).watch((onBattery) => {
			observed.push(onBattery);
		});

		try {
			await waitFor(() => observed.includes(true));
			await writeFile(path.join(root, 'AC0', 'online'), '1\n');
			await waitFor(() => observed.includes(false));
		} finally {
			stop();
		}
	});
});

async function createPowerSupplyTree(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), 'agent-glow-power-supply-'));
	temporaryDirectories.push(root);
	return root;
}

async function addSupply(
	root: string,
	name: string,
	values: { readonly online?: string; readonly status?: string; readonly type: string },
): Promise<void> {
	const directory = path.join(root, name);
	await mkdir(directory);
	await writeFile(path.join(directory, 'type'), `${values.type}\n`);
	if (values.online !== undefined) {
		await writeFile(path.join(directory, 'online'), `${values.online}\n`);
	}
	if (values.status !== undefined) {
		await writeFile(path.join(directory, 'status'), `${values.status}\n`);
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 500;
	while (performance.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('Timed out waiting for power source change');
}
