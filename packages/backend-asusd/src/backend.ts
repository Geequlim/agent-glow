import { createHash } from 'node:crypto';

import type {
	BackendApplyResult,
	BackendSnapshot,
	LightingBackend,
	StaticVisualState,
} from '@agent-glow/core/backend';
import type { DeviceDescriptor } from '@agent-glow/protocol/device';

import { DbusAsusdTransport } from './dbus-transport.js';
import type { AsusdTransport, DbusProperty, ManagedObject } from './transport.js';

const AURA_INTERFACE = 'xyz.ljones.Aura';
const SLASH_INTERFACE = 'xyz.ljones.Slash';
const LED_MODE_DATA = 'LedModeData';
const LED_MODE_DATA_SIGNATURE = '(uu(yyy)(yyy)ss)';
const SLASH_PROPERTIES = ['Enabled', 'Brightness', 'Interval', 'Mode'] as const;

interface AuraDevice {
	readonly descriptor: DeviceDescriptor;
	readonly kind: 'aura';
	readonly path: string;
}

interface SlashDevice {
	readonly descriptor: DeviceDescriptor;
	readonly kind: 'slash';
	readonly path: string;
}

type AsusdDevice = AuraDevice | SlashDevice;
export type AsusdDeviceKind = AsusdDevice['kind'];

interface AuraSnapshotValue {
	readonly interfaceName: typeof AURA_INTERFACE;
	readonly property: DbusProperty;
}

interface SlashSnapshotValue {
	readonly interfaceName: typeof SLASH_INTERFACE;
	readonly properties: Readonly<Record<(typeof SLASH_PROPERTIES)[number], DbusProperty>>;
}

interface SlashEffect {
	readonly brightness: number;
	readonly interval: number;
	readonly mode: number;
	readonly name: string;
}

const slashEffects = {
	idle: { name: 'Phantom', mode: 0x24, brightness: 51, interval: 5 },
	paused: { name: 'Bounce', mode: 0x10, brightness: 77, interval: 3 },
	working: { name: 'Loading', mode: 0x13, brightness: 179, interval: 0 },
	waiting_permission: { name: 'Buzzer', mode: 0x44, brightness: 255, interval: 1 },
	success: { name: 'Slash', mode: 0x12, brightness: 230, interval: 2 },
	error: { name: 'Hazard', mode: 0x32, brightness: 255, interval: 0 },
} as const satisfies Readonly<Record<StaticVisualState['semanticState'], SlashEffect>>;

export class AsusdLightingBackend implements LightingBackend {
	readonly id = 'asusd';

	readonly #transport: AsusdTransport;
	readonly #deviceKind: AsusdDeviceKind | undefined;
	readonly #lastSlashState = new Map<string, string>();
	readonly #slashModeWritable = new Map<string, boolean>();
	#devices: readonly AsusdDevice[] | undefined;
	#closed = false;

	constructor(
		transport: AsusdTransport = new DbusAsusdTransport(),
		deviceKind?: AsusdDeviceKind,
	) {
		this.#transport = transport;
		this.#deviceKind = deviceKind;
	}

	getHealth(): 'healthy' | 'unavailable' {
		return this.#closed ? 'unavailable' : 'healthy';
	}

	async discoverDevices(): Promise<readonly DeviceDescriptor[]> {
		return (await this.#discoverDevices()).map((device) => device.descriptor);
	}

	async captureSnapshot(deviceId: string): Promise<BackendSnapshot> {
		const device = await this.#findDevice(deviceId);
		if (device.kind === 'slash') {
			const properties = {} as Record<(typeof SLASH_PROPERTIES)[number], DbusProperty>;
			for (const propertyName of SLASH_PROPERTIES) {
				const property = await this.#transport.getProperty(
					device.path,
					SLASH_INTERFACE,
					propertyName,
				);
				assertSlashProperty(propertyName, property);
				properties[propertyName] = structuredClone(property);
			}
			return {
				backendId: this.id,
				deviceId,
				value: {
					interfaceName: SLASH_INTERFACE,
					properties,
				} satisfies SlashSnapshotValue,
			};
		}

		const property = await this.#transport.getProperty(
			device.path,
			AURA_INTERFACE,
			LED_MODE_DATA,
		);
		assertLedModeData(property);
		return {
			backendId: this.id,
			deviceId,
			value: {
				interfaceName: AURA_INTERFACE,
				property: structuredClone(property),
			} satisfies AuraSnapshotValue,
		};
	}

	async applyVisualState(
		deviceId: string,
		visualState: StaticVisualState,
	): Promise<BackendApplyResult> {
		const device = await this.#findDevice(deviceId);
		if (device.kind === 'slash') {
			return this.#applySlashState(device, visualState);
		}

		const current = await this.#transport.getProperty(
			device.path,
			AURA_INTERFACE,
			LED_MODE_DATA,
		);
		assertLedModeData(current);

		const value = structuredClone(current.value);
		value[2] = [
			scaleChannel(visualState.color.red, visualState.intensity),
			scaleChannel(visualState.color.green, visualState.intensity),
			scaleChannel(visualState.color.blue, visualState.intensity),
		];
		await this.#transport.setProperty(device.path, AURA_INTERFACE, LED_MODE_DATA, {
			signature: LED_MODE_DATA_SIGNATURE,
			value,
		});

		return {
			requested: visualState,
			applied: visualState,
			degraded: false,
		};
	}

	async restoreSnapshot(snapshot: BackendSnapshot): Promise<void> {
		if (snapshot.backendId !== this.id) throw new Error('Snapshot belongs to another backend');
		const device = await this.#findDevice(snapshot.deviceId);
		if (device.kind === 'slash') {
			const value = readSlashSnapshot(snapshot.value);
			for (const propertyName of ['Interval', 'Brightness', 'Enabled'] as const) {
				await this.#transport.setProperty(
					device.path,
					value.interfaceName,
					propertyName,
					value.properties[propertyName],
				);
			}
			if (this.#slashModeWritable.get(device.descriptor.id) !== false) {
				await this.#transport.setProperty(
					device.path,
					value.interfaceName,
					'Mode',
					value.properties.Mode,
				);
			}
			this.#lastSlashState.delete(device.descriptor.id);
			this.#slashModeWritable.delete(device.descriptor.id);
			return;
		}

		const value = readAuraSnapshot(snapshot.value);
		await this.#transport.setProperty(
			device.path,
			value.interfaceName,
			LED_MODE_DATA,
			value.property,
		);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#transport.close();
	}

	async #discoverDevices(): Promise<readonly AsusdDevice[]> {
		this.#assertOpen();
		if (this.#devices) return this.#devices;

		const devices = (await this.#transport.readManagedObjects())
			.flatMap((object) => {
				const discovered: AsusdDevice[] = [];
				const aura = toAuraDevice(object);
				const slash = toSlashDevice(object);
				if (aura) discovered.push(aura);
				if (slash) discovered.push(slash);
				return discovered;
			})
			.filter((device) => !this.#deviceKind || device.kind === this.#deviceKind);
		if (devices.length === 0)
			throw new Error('asusd did not expose a writable lighting device');
		this.#devices = devices;
		return devices;
	}

	async #findDevice(deviceId: string): Promise<AsusdDevice> {
		const device = (await this.#discoverDevices()).find(
			(candidate) => candidate.descriptor.id === deviceId,
		);
		if (!device) throw new Error(`Unknown asusd device: ${deviceId}`);
		return device;
	}

	async #applySlashState(
		device: SlashDevice,
		visualState: StaticVisualState,
	): Promise<BackendApplyResult> {
		const effect = slashEffects[visualState.semanticState];
		const brightness = Math.round(
			Math.max(0, Math.min(1, visualState.hardwareIntensity)) * 255,
		);
		const stateKey = `${effect.mode}:${effect.interval}:${brightness}`;
		if (this.#lastSlashState.get(device.descriptor.id) === stateKey) {
			return { requested: visualState, applied: visualState, degraded: false };
		}

		let modeError: unknown;
		try {
			await this.#transport.setProperty(device.path, SLASH_INTERFACE, 'Mode', {
				signature: 'u',
				value: effect.mode,
			});
			this.#slashModeWritable.set(device.descriptor.id, true);
		} catch (error) {
			modeError = error;
			this.#slashModeWritable.set(device.descriptor.id, false);
		}
		await this.#transport.setProperty(device.path, SLASH_INTERFACE, 'Interval', {
			signature: 'y',
			value: effect.interval,
		});
		await this.#transport.setProperty(device.path, SLASH_INTERFACE, 'Brightness', {
			signature: 'y',
			value: brightness,
		});
		await this.#transport.setProperty(device.path, SLASH_INTERFACE, 'Enabled', {
			signature: 'b',
			value: true,
		});
		this.#lastSlashState.set(device.descriptor.id, stateKey);
		console.log(
			`[agent-glow] slash state=${visualState.semanticState} mode=${effect.name} brightness=${brightness}/255 interval=${effect.interval}${modeError ? ' degraded=mode-unavailable' : ''}`,
		);
		return {
			requested: visualState,
			applied: visualState,
			degraded: modeError !== undefined,
			...(modeError
				? {
						reason: `Slash mode unavailable: ${
							modeError instanceof Error ? modeError.message : String(modeError)
						}`,
					}
				: {}),
		};
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error('asusd backend is closed');
	}
}

function toAuraDevice(object: ManagedObject): AuraDevice | undefined {
	const aura = object.interfaces.find((item) => item.name === AURA_INTERFACE);
	const modeData = aura?.properties[LED_MODE_DATA];
	if (!aura || !modeData) return undefined;

	try {
		assertLedModeData(modeData);
	} catch {
		return undefined;
	}

	const stableSuffix = createHash('sha256').update(object.path).digest('hex').slice(0, 12);
	return {
		kind: 'aura',
		path: object.path,
		descriptor: {
			id: `asusd:aura-${stableSuffix}`,
			name: 'ROG Aura',
			capabilities: ['power', 'static_color', 'brightness'],
		},
	};
}

function toSlashDevice(object: ManagedObject): SlashDevice | undefined {
	const slash = object.interfaces.find((item) => item.name === SLASH_INTERFACE);
	if (!slash) return undefined;
	try {
		for (const propertyName of SLASH_PROPERTIES) {
			const property = slash.properties[propertyName];
			if (!property) return undefined;
			assertSlashProperty(propertyName, property);
		}
	} catch {
		return undefined;
	}

	const stableSuffix = createHash('sha256').update(object.path).digest('hex').slice(0, 12);
	return {
		kind: 'slash',
		path: object.path,
		descriptor: {
			id: `asusd:slash-${stableSuffix}`,
			name: 'ROG Slash',
			capabilities: ['power', 'brightness', 'firmware_effect'],
		},
	};
}

function assertLedModeData(property: DbusProperty): asserts property is DbusProperty & {
	readonly value: [unknown, unknown, number[], unknown, unknown, unknown];
} {
	if (
		property.signature !== LED_MODE_DATA_SIGNATURE ||
		!Array.isArray(property.value) ||
		property.value.length !== 6 ||
		!Array.isArray(property.value[2]) ||
		property.value[2].length !== 3
	) {
		throw new Error('Aura.LedModeData has an unsupported shape');
	}
}

function readAuraSnapshot(value: unknown): AuraSnapshotValue {
	if (
		!value ||
		typeof value !== 'object' ||
		!('interfaceName' in value) ||
		value.interfaceName !== AURA_INTERFACE ||
		!('property' in value) ||
		!value.property ||
		typeof value.property !== 'object' ||
		!('signature' in value.property) ||
		!('value' in value.property)
	) {
		throw new Error('Invalid Aura snapshot');
	}
	const property = value.property as DbusProperty;
	assertLedModeData(property);
	return { interfaceName: AURA_INTERFACE, property };
}

function assertSlashProperty(
	propertyName: (typeof SLASH_PROPERTIES)[number],
	property: DbusProperty,
): void {
	const expectedSignature =
		propertyName === 'Enabled' ? 'b' : propertyName === 'Mode' ? 'u' : 'y';
	if (
		property.signature !== expectedSignature ||
		(expectedSignature === 'b'
			? typeof property.value !== 'boolean'
			: !Number.isInteger(property.value) ||
				(property.value as number) < 0 ||
				(property.value as number) > (expectedSignature === 'y' ? 255 : 0xff_ff_ff_ff))
	) {
		throw new Error(`Slash.${propertyName} has an unsupported value`);
	}
}

function readSlashSnapshot(value: unknown): SlashSnapshotValue {
	if (
		!value ||
		typeof value !== 'object' ||
		!('interfaceName' in value) ||
		value.interfaceName !== SLASH_INTERFACE ||
		!('properties' in value) ||
		!value.properties ||
		typeof value.properties !== 'object'
	) {
		throw new Error('Invalid Slash snapshot');
	}
	const properties = value.properties as Record<string, DbusProperty>;
	for (const propertyName of SLASH_PROPERTIES) {
		const property = properties[propertyName];
		if (!property) throw new Error(`Slash snapshot is missing ${propertyName}`);
		assertSlashProperty(propertyName, property);
	}
	return {
		interfaceName: SLASH_INTERFACE,
		properties: properties as SlashSnapshotValue['properties'],
	};
}

function scaleChannel(channel: number, intensity: number): number {
	return Math.round(Math.max(0, Math.min(255, channel)) * Math.max(0, Math.min(1, intensity)));
}
