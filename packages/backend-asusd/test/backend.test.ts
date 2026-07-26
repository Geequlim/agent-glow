import { describe, expect, it } from 'vitest';

import { AsusdLightingBackend } from '../src/backend.js';
import type {
	AsusdLifecycleEvent,
	AsusdTransport,
	DbusProperty,
	ManagedObject,
} from '../src/transport.js';

const auraPath = '/xyz/ljones/aura/19b6_4_5';
const initialModeData: DbusProperty = {
	signature: '(uu(yyy)(yyy)ss)',
	value: [0, 0, [0, 0, 0], [0, 0, 0], 'Med', 'Right'],
};
const initialSlashProperties = {
	Enabled: { signature: 'b', value: false },
	Brightness: { signature: 'y', value: 64 },
	Interval: { signature: 'y', value: 1 },
	Mode: { signature: 'u', value: 0x32 },
} as const satisfies Readonly<Record<string, DbusProperty>>;

class FixtureTransport implements AsusdTransport {
	readonly writes: DbusProperty[] = [];
	readonly slashWrites: Array<{ readonly name: string; readonly property: DbusProperty }> = [];
	current = structuredClone(initialModeData);
	slash: Record<string, DbusProperty> = structuredClone(initialSlashProperties);
	closed = false;
	failSlashMode = false;
	lifecycleListener: ((event: AsusdLifecycleEvent) => void) | undefined;
	managedObjectReads = 0;

	async readManagedObjects(): Promise<readonly ManagedObject[]> {
		this.managedObjectReads += 1;
		return [
			{
				path: auraPath,
				interfaces: [
					{
						name: 'xyz.ljones.Aura',
						properties: { LedModeData: this.current },
					},
					{
						name: 'xyz.ljones.Slash',
						properties: this.slash,
					},
				],
			},
		];
	}

	async callMethod(): Promise<unknown> {
		return undefined;
	}

	async getProperty(
		_path: string,
		interfaceName: string,
		propertyName: string,
	): Promise<DbusProperty> {
		if (interfaceName === 'xyz.ljones.Slash') {
			const property = this.slash[propertyName];
			if (!property) throw new Error(`Unknown Slash property: ${propertyName}`);
			return structuredClone(property);
		}
		return structuredClone(this.current);
	}

	async setProperty(
		_path: string,
		interfaceName: string,
		propertyName: string,
		property: DbusProperty,
	): Promise<void> {
		if (interfaceName === 'xyz.ljones.Slash') {
			if (propertyName === 'Mode' && this.failSlashMode) {
				throw new Error('incorrect type');
			}
			this.slash[propertyName] = structuredClone(property);
			this.slashWrites.push({ name: propertyName, property: structuredClone(property) });
			return;
		}
		this.current = structuredClone(property);
		this.writes.push(structuredClone(property));
	}

	close(): void {
		this.closed = true;
	}

	watchLifecycle(listener: (event: AsusdLifecycleEvent) => void): () => void {
		this.lifecycleListener = listener;
		return () => {
			this.lifecycleListener = undefined;
		};
	}

	emitLifecycle(event: AsusdLifecycleEvent): void {
		this.lifecycleListener?.(event);
	}
}

describe('AsusdLightingBackend', () => {
	it('discovers Aura by interface without exposing its object path', async () => {
		const backend = new AsusdLightingBackend(new FixtureTransport());

		const devices = await backend.discoverDevices();

		expect(devices).toHaveLength(2);
		const aura = devices.find((device) => device.id.startsWith('asusd:aura-'));
		expect(aura?.id).toMatch(/^asusd:aura-[a-f0-9]{12}$/u);
		expect(aura?.id).not.toContain(auraPath);
		expect(aura?.capabilities).toContain('static_color');
		const slash = devices.find((device) => device.id.startsWith('asusd:slash-'));
		expect(slash?.capabilities).toEqual(['power', 'brightness', 'firmware_effect']);
	});

	it('applies a scaled static color and restores the full original value', async () => {
		const transport = new FixtureTransport();
		const backend = new AsusdLightingBackend(transport);
		const device = (await backend.discoverDevices()).find((item) =>
			item.id.startsWith('asusd:aura-'),
		);
		if (!device) throw new Error('Fixture device missing');
		const snapshot = await backend.captureSnapshot(device.id);

		await backend.applyVisualState(device.id, {
			color: { red: 64, green: 32, blue: 16 },
			hardwareIntensity: 0.7,
			intensity: 0.5,
			semanticState: 'working',
		});

		expect(transport.current.value).toEqual([0, 0, [32, 16, 8], [0, 0, 0], 'Med', 'Right']);

		await backend.restoreSnapshot(snapshot);

		expect(transport.current).toEqual(initialModeData);
	});

	it('maps semantic states to Slash firmware effects and restores all properties', async () => {
		const transport = new FixtureTransport();
		const backend = new AsusdLightingBackend(transport);
		const device = (await backend.discoverDevices()).find((item) =>
			item.id.startsWith('asusd:slash-'),
		);
		if (!device) throw new Error('Slash fixture device missing');
		const snapshot = await backend.captureSnapshot(device.id);
		const visualState = {
			color: { red: 255, green: 159, blue: 28 },
			hardwareIntensity: 0.5,
			intensity: 0.5,
			semanticState: 'waiting_permission',
		} as const;

		await backend.applyVisualState(device.id, visualState);
		await backend.applyVisualState(device.id, { ...visualState, intensity: 0.8 });

		expect(transport.slash).toEqual({
			Enabled: { signature: 'b', value: true },
			Brightness: { signature: 'y', value: 255 },
			Interval: { signature: 'y', value: 1 },
			Mode: { signature: 'u', value: 0x44 },
		});
		expect(transport.slashWrites).toHaveLength(4);

		await backend.restoreSnapshot(snapshot);

		expect(transport.slash).toEqual({
			...initialSlashProperties,
			Mode: { signature: 'u', value: 0x32 },
		});
	});

	it('registers Slash settings and applies runtime configuration updates', async () => {
		const transport = new FixtureTransport();
		const backend = new AsusdLightingBackend(transport);
		const device = (await backend.discoverDevices()).find((item) =>
			item.id.startsWith('asusd:slash-'),
		);
		if (!device) throw new Error('Slash fixture device missing');

		const configuration = await backend.getDeviceConfiguration(device.id);

		expect(configuration.settings).toHaveLength(18);
		expect(
			configuration.settings.find((setting) => setting.key === 'states.working.effect'),
		).toMatchObject({
			kind: 'select',
			defaultValue: 'loading',
			options: expect.arrayContaining([{ value: 'spectrum', label: 'Spectrum' }]),
		});

		await backend.updateDeviceConfiguration(device.id, {
			'states.working.effect': 'spectrum',
			'states.working.brightness': 100,
			'states.working.interval': 4,
		});
		await backend.applyVisualState(device.id, {
			color: { red: 88, green: 101, blue: 242 },
			hardwareIntensity: 0.7,
			intensity: 1,
			semanticState: 'working',
		});

		expect(transport.slash).toMatchObject({
			Enabled: { value: true },
			Brightness: { value: 100 },
			Interval: { value: 4 },
			Mode: { value: 0x26 },
		});
		const result = await backend.applyVisualState(device.id, {
			color: { red: 88, green: 101, blue: 242 },
			hardwareIntensity: 0.7,
			intensity: 0.5,
			semanticState: 'working',
		});
		expect(result.details).toEqual({
			requested: {
				firmwareEffect: 'Spectrum',
				brightness: 100,
				color: 'rgb(88,101,242)',
				interval: 4,
				power: true,
			},
			applied: {
				firmwareEffect: 'Spectrum',
				brightness: 100,
				color: 'unsupported',
				interval: 4,
				power: true,
			},
		});
		expect(result).toMatchObject({
			degraded: true,
			reason: expect.stringContaining('Static color unavailable'),
		});
	});

	it('degrades a rejected Slash mode without blocking brightness or restoration', async () => {
		const transport = new FixtureTransport();
		transport.failSlashMode = true;
		const backend = new AsusdLightingBackend(transport);
		const device = (await backend.discoverDevices()).find((item) =>
			item.id.startsWith('asusd:slash-'),
		);
		if (!device) throw new Error('Slash fixture device missing');
		const snapshot = await backend.captureSnapshot(device.id);

		const result = await backend.applyVisualState(device.id, {
			color: { red: 88, green: 101, blue: 242 },
			hardwareIntensity: 0.7,
			intensity: 1,
			semanticState: 'working',
		});

		expect(result).toMatchObject({
			degraded: true,
			reason: expect.stringContaining('incorrect type'),
		});
		expect(
			await backend.applyVisualState(device.id, {
				color: { red: 88, green: 101, blue: 242 },
				hardwareIntensity: 0.7,
				intensity: 0.5,
				semanticState: 'working',
			}),
		).toMatchObject({
			degraded: true,
			reason: expect.stringContaining('incorrect type'),
		});
		expect(transport.slash).toMatchObject({
			Enabled: { value: true },
			Brightness: { value: 179 },
			Interval: { value: 0 },
			Mode: { value: 0x32 },
		});

		await backend.restoreSnapshot(snapshot);

		expect(transport.slash).toEqual(initialSlashProperties);
	});

	it('closes its transport once', async () => {
		const transport = new FixtureTransport();
		const backend = new AsusdLightingBackend(transport);

		await backend.close();
		await backend.close();

		expect(transport.closed).toBe(true);
		expect(backend.getHealth()).toBe('unavailable');
	});

	it('invalidates discovery and reports lifecycle changes after service restart', async () => {
		const transport = new FixtureTransport();
		const backend = new AsusdLightingBackend(transport);
		const events: AsusdLifecycleEvent[] = [];
		backend.watchLifecycle((event) => events.push(event));
		await backend.discoverDevices();

		transport.emitLifecycle({ type: 'availability', available: false });
		expect(backend.getHealth()).toBe('unavailable');
		await expect(backend.discoverDevices()).rejects.toThrow('service is unavailable');

		transport.emitLifecycle({ type: 'availability', available: true });
		await backend.discoverDevices();
		transport.emitLifecycle({ type: 'sleep', sleeping: true });
		transport.emitLifecycle({ type: 'sleep', sleeping: false });

		expect(transport.managedObjectReads).toBe(2);
		expect(events).toEqual([
			{ type: 'availability', available: false },
			{ type: 'availability', available: true },
			{ type: 'sleep', sleeping: true },
			{ type: 'sleep', sleeping: false },
		]);
	});
});
