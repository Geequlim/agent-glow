import { createHash } from 'node:crypto';

import type {
	BackendApplyResult,
	BackendLifecycleEvent,
	BackendSnapshot,
	LightingBackend,
	StaticVisualState,
} from '@agent-glow/core/backend';
import { mergeDeviceConfiguration } from '@agent-glow/core/device-configuration';
import type { DeviceDescriptor } from '@agent-glow/protocol/device';
import type {
	DeviceConfiguration,
	DeviceConfigurationSetting,
	DeviceConfigurationValues,
} from '@agent-glow/protocol/device-configuration';

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
	readonly mode: number;
	readonly name: string;
}

const slashEffects = {
	static: { name: 'Static', mode: 0x06 },
	bounce: { name: 'Bounce', mode: 0x10 },
	slash: { name: 'Slash', mode: 0x12 },
	loading: { name: 'Loading', mode: 0x13 },
	bit_stream: { name: 'BitStream', mode: 0x1d },
	transmission: { name: 'Transmission', mode: 0x1a },
	flow: { name: 'Flow', mode: 0x19 },
	flux: { name: 'Flux', mode: 0x25 },
	phantom: { name: 'Phantom', mode: 0x24 },
	spectrum: { name: 'Spectrum', mode: 0x26 },
	hazard: { name: 'Hazard', mode: 0x32 },
	interfacing: { name: 'Interfacing', mode: 0x33 },
	ramp: { name: 'Ramp', mode: 0x34 },
	game_over: { name: 'GameOver', mode: 0x42 },
	start: { name: 'Start', mode: 0x43 },
	buzzer: { name: 'Buzzer', mode: 0x44 },
} as const satisfies Readonly<Record<string, SlashEffect>>;

type SlashEffectId = keyof typeof slashEffects;

const slashDefaults = {
	idle: { effect: 'phantom', brightness: 51, interval: 5 },
	paused: { effect: 'bounce', brightness: 77, interval: 3 },
	working: { effect: 'loading', brightness: 179, interval: 0 },
	waiting_permission: { effect: 'buzzer', brightness: 255, interval: 1 },
	success: { effect: 'slash', brightness: 230, interval: 2 },
	error: { effect: 'hazard', brightness: 255, interval: 0 },
} as const satisfies Readonly<
	Record<
		StaticVisualState['semanticState'],
		{ readonly effect: SlashEffectId; readonly brightness: number; readonly interval: number }
	>
>;

export class AsusdLightingBackend implements LightingBackend {
	readonly id = 'asusd';

	readonly #transport: AsusdTransport;
	readonly #deviceKind: AsusdDeviceKind | undefined;
	readonly #lastSlashResult = new Map<string, BackendApplyResult>();
	readonly #lastSlashState = new Map<string, string>();
	readonly #slashModeWritable = new Map<string, boolean>();
	readonly #slashConfiguration = new Map<string, DeviceConfigurationValues>();
	readonly #lifecycleListeners = new Set<(event: BackendLifecycleEvent) => void>();
	readonly #stopLifecycleWatch: (() => void) | undefined;
	#devices: readonly AsusdDevice[] | undefined;
	#available = true;
	#closed = false;

	constructor(
		transport: AsusdTransport = new DbusAsusdTransport(),
		deviceKind?: AsusdDeviceKind,
	) {
		this.#transport = transport;
		this.#deviceKind = deviceKind;
		this.#stopLifecycleWatch = transport.watchLifecycle?.((event) => {
			if (event.type === 'availability') {
				this.#available = event.available;
				this.#devices = undefined;
				this.#lastSlashState.clear();
				this.#lastSlashResult.clear();
				this.#slashModeWritable.clear();
			}
			for (const listener of this.#lifecycleListeners) listener(event);
		});
	}

	getHealth(): 'healthy' | 'unavailable' {
		return this.#closed || !this.#available ? 'unavailable' : 'healthy';
	}

	async discoverDevices(): Promise<readonly DeviceDescriptor[]> {
		return (await this.#discoverDevices()).map((device) => device.descriptor);
	}

	async getDeviceConfiguration(deviceId: string): Promise<DeviceConfiguration> {
		const device = await this.#findDevice(deviceId);
		if (device.kind === 'aura') return { deviceId, settings: [], values: {} };
		return {
			deviceId,
			settings: slashConfigurationSettings,
			values: { ...this.#getSlashConfiguration(deviceId) },
		};
	}

	async updateDeviceConfiguration(
		deviceId: string,
		values: DeviceConfigurationValues,
	): Promise<void> {
		const current = await this.getDeviceConfiguration(deviceId);
		if (current.settings.length === 0 && Object.keys(values).length > 0) {
			throw new Error('Device does not register configuration settings');
		}
		const updated = mergeDeviceConfiguration(current, values);
		this.#slashConfiguration.set(deviceId, updated.values);
		this.#lastSlashState.delete(deviceId);
		this.#lastSlashResult.delete(deviceId);
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
			this.#lastSlashResult.delete(device.descriptor.id);
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
		this.#stopLifecycleWatch?.();
		this.#lifecycleListeners.clear();
		this.#transport.close();
	}

	watchLifecycle(listener: (event: BackendLifecycleEvent) => void): () => void {
		this.#lifecycleListeners.add(listener);
		return () => this.#lifecycleListeners.delete(listener);
	}

	async #discoverDevices(): Promise<readonly AsusdDevice[]> {
		this.#assertOpen();
		if (!this.#available) throw new Error('asusd service is unavailable');
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
		const prefix = `states.${visualState.semanticState}`;
		const configuration = this.#getSlashConfiguration(device.descriptor.id);
		const effect = slashEffects[configuration[`${prefix}.effect`] as SlashEffectId];
		const brightness = configuration[`${prefix}.brightness`] as number;
		const interval = configuration[`${prefix}.interval`] as number;
		const stateKey = `${effect.mode}:${interval}:${brightness}`;
		if (this.#lastSlashState.get(device.descriptor.id) === stateKey) {
			const previous = this.#lastSlashResult.get(device.descriptor.id);
			if (previous) return { ...previous, requested: visualState, applied: visualState };
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
			value: interval,
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
			`[agent-glow] slash state=${visualState.semanticState} mode=${effect.name} brightness=${brightness}/255 interval=${interval}${modeError ? ' degraded=mode-unavailable' : ''}`,
		);
		const colorReason = 'Static color unavailable; applied configured firmware effect';
		const reason = modeError
			? `${colorReason}; firmware mode unavailable: ${
					modeError instanceof Error ? modeError.message : String(modeError)
				}`
			: colorReason;
		const result: BackendApplyResult = {
			requested: visualState,
			applied: visualState,
			degraded: true,
			details: {
				requested: {
					firmwareEffect: effect.name,
					brightness,
					color: formatColor(visualState.color),
					interval,
					power: true,
				},
				applied: {
					...(modeError ? {} : { firmwareEffect: effect.name }),
					brightness,
					color: 'unsupported',
					interval,
					power: true,
				},
			},
			reason,
		};
		this.#lastSlashResult.set(device.descriptor.id, result);
		return result;
	}

	#getSlashConfiguration(deviceId: string): DeviceConfigurationValues {
		const existing = this.#slashConfiguration.get(deviceId);
		if (existing) return existing;
		const defaults = Object.fromEntries(
			Object.entries(slashDefaults).flatMap(([state, value]) => [
				[`states.${state}.effect`, value.effect],
				[`states.${state}.brightness`, value.brightness],
				[`states.${state}.interval`, value.interval],
			]),
		);
		this.#slashConfiguration.set(deviceId, defaults);
		return defaults;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error('asusd backend is closed');
	}
}

const slashConfigurationSettings: DeviceConfigurationSetting[] = Object.entries(
	slashDefaults,
).flatMap(([state, defaults]) => {
	const group = state.replaceAll('_', ' ');
	return [
		{
			key: `states.${state}.effect`,
			label: 'Animation',
			group,
			kind: 'select',
			defaultValue: defaults.effect,
			options: Object.entries(slashEffects).map(([value, effect]) => ({
				value,
				label: effect.name,
			})),
		},
		{
			key: `states.${state}.brightness`,
			label: 'Brightness',
			group,
			kind: 'integer',
			defaultValue: defaults.brightness,
			minimum: 0,
			maximum: 255,
			step: 1,
		},
		{
			key: `states.${state}.interval`,
			label: 'Animation interval',
			group,
			kind: 'integer',
			defaultValue: defaults.interval,
			minimum: 0,
			maximum: 5,
			step: 1,
		},
	] satisfies DeviceConfigurationSetting[];
});

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

function formatColor(color: StaticVisualState['color']): string {
	return `rgb(${color.red},${color.green},${color.blue})`;
}
