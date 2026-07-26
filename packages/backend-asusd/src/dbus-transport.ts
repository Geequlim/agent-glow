import { systemBus, type DBusInterface, type MessageBus } from '@homebridge/dbus-native';

import type {
	AsusdLifecycleEvent,
	AsusdTransport,
	DbusProperty,
	ManagedInterface,
	ManagedObject,
} from './transport.js';

const ASUS_SERVICE = 'xyz.ljones.Asusd';
const DBUS_REQUEST_TIMEOUT_MS = 1000;

interface DbusMessage {
	readonly body?: readonly unknown[];
	readonly destination: string;
	readonly interface: string;
	readonly member: string;
	readonly path: string;
	readonly signature?: string;
}

interface SignatureNode {
	readonly child?: readonly SignatureNode[];
	readonly type: string;
}

export class DbusAsusdTransport implements AsusdTransport {
	readonly #bus: MessageBus;

	constructor(bus: MessageBus = systemBus()) {
		this.#bus = bus;
	}

	async readManagedObjects(): Promise<readonly ManagedObject[]> {
		const rawObjects = await invoke(this.#bus, {
			destination: ASUS_SERVICE,
			path: '/',
			interface: 'org.freedesktop.DBus.ObjectManager',
			member: 'GetManagedObjects',
		});
		if (!Array.isArray(rawObjects)) throw new Error('ObjectManager returned a non-array value');
		return rawObjects.map(readManagedObject);
	}

	async callMethod(path: string, interfaceName: string, methodName: string): Promise<unknown> {
		return invoke(this.#bus, {
			destination: ASUS_SERVICE,
			path,
			interface: interfaceName,
			member: methodName,
		});
	}

	async getProperty(
		path: string,
		interfaceName: string,
		propertyName: string,
	): Promise<DbusProperty> {
		const value = await invoke(this.#bus, {
			destination: ASUS_SERVICE,
			path,
			interface: 'org.freedesktop.DBus.Properties',
			member: 'Get',
			signature: 'ss',
			body: [interfaceName, propertyName],
		});
		return readVariant(value);
	}

	async setProperty(
		path: string,
		interfaceName: string,
		propertyName: string,
		property: DbusProperty,
	): Promise<void> {
		await invoke(this.#bus, {
			destination: ASUS_SERVICE,
			path,
			interface: 'org.freedesktop.DBus.Properties',
			member: 'Set',
			signature: 'ssv',
			body: [interfaceName, propertyName, [property.signature, property.value]],
		});
	}

	watchLifecycle(listener: (event: AsusdLifecycleEvent) => void): () => void {
		let disposed = false;
		const cleanups = [
			this.#watchSignal(
				'org.freedesktop.DBus',
				'/org/freedesktop/DBus',
				'org.freedesktop.DBus',
				'NameOwnerChanged',
				(name: unknown, _oldOwner: unknown, newOwner: unknown) => {
					if (name === ASUS_SERVICE && typeof newOwner === 'string') {
						listener({ type: 'availability', available: newOwner.length > 0 });
					}
				},
			),
			this.#watchSignal(
				'org.freedesktop.login1',
				'/org/freedesktop/login1',
				'org.freedesktop.login1.Manager',
				'PrepareForSleep',
				(sleeping: unknown) => {
					if (typeof sleeping === 'boolean') listener({ type: 'sleep', sleeping });
				},
			),
		];
		void invoke(this.#bus, {
			destination: 'org.freedesktop.DBus',
			path: '/org/freedesktop/DBus',
			interface: 'org.freedesktop.DBus',
			member: 'NameHasOwner',
			signature: 's',
			body: [ASUS_SERVICE],
		})
			.then((available) => {
				if (!disposed && typeof available === 'boolean') {
					listener({ type: 'availability', available });
				}
			})
			.catch((error: unknown) => {
				if (!disposed) {
					console.error(
						`[agent-glow] failed to read asusd availability error=${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			});
		return () => {
			disposed = true;
			for (const cleanup of cleanups) cleanup();
		};
	}

	close(): void {
		this.#bus.connection.stream.destroy();
	}

	#watchSignal(
		serviceName: string,
		path: string,
		interfaceName: string,
		signalName: string,
		listener: (...values: unknown[]) => void,
	): () => void {
		let disposed = false;
		let watchedInterface: DBusInterface | undefined;
		this.#bus
			.getService(serviceName)
			.getInterface(path, interfaceName, (error, dbusInterface) => {
				if (error || !dbusInterface) {
					console.error(
						`[agent-glow] failed to watch D-Bus signal interface=${interfaceName} signal=${signalName} error=${error?.message ?? 'interface unavailable'}`,
					);
					return;
				}
				if (disposed) return;
				watchedInterface = dbusInterface;
				dbusInterface.on(signalName, listener);
			});
		return () => {
			disposed = true;
			watchedInterface?.removeListener(signalName, listener);
		};
	}
}

function invoke(bus: MessageBus, message: DbusMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(
				new Error(
					`D-Bus request timed out interface=${message.interface} member=${message.member}`,
				),
			);
		}, DBUS_REQUEST_TIMEOUT_MS);
		bus.invoke(message, (error, ...values: unknown[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) {
				reject(new Error(`${error.name}: ${String(error.message)}`));
				return;
			}
			resolve(values.length === 1 ? values[0] : values);
		});
	});
}

function readManagedObject(value: unknown): ManagedObject {
	const [path, rawInterfaces] = readPair(value, 'managed object');
	if (typeof path !== 'string' || !Array.isArray(rawInterfaces)) {
		throw new Error('ObjectManager returned an invalid object entry');
	}
	return { path, interfaces: rawInterfaces.map(readManagedInterface) };
}

function readManagedInterface(value: unknown): ManagedInterface {
	const [name, rawProperties] = readPair(value, 'managed interface');
	if (typeof name !== 'string' || !Array.isArray(rawProperties)) {
		throw new Error('ObjectManager returned an invalid interface entry');
	}

	const properties: Record<string, DbusProperty> = {};
	for (const rawProperty of rawProperties) {
		const [propertyName, rawVariant] = readPair(rawProperty, 'managed property');
		if (typeof propertyName !== 'string') {
			throw new Error('ObjectManager returned an invalid property name');
		}
		properties[propertyName] = readVariant(rawVariant);
	}
	return { name, properties };
}

function readVariant(value: unknown): DbusProperty {
	const [rawSignature, rawValues] = readPair(value, 'variant');
	if (
		!Array.isArray(rawSignature) ||
		rawSignature.length !== 1 ||
		!Array.isArray(rawValues) ||
		rawValues.length !== 1
	) {
		throw new Error('D-Bus returned an invalid variant');
	}
	return { signature: readSignature(rawSignature[0]), value: rawValues[0] };
}

function readSignature(value: unknown): string {
	if (!isSignatureNode(value)) throw new Error('D-Bus returned an invalid signature node');
	if (value.type === '(' || value.type === '{') {
		return `${value.type}${(value.child ?? []).map(readSignature).join('')}${
			value.type === '(' ? ')' : '}'
		}`;
	}
	if (value.type === 'a') {
		const child = value.child?.[0];
		if (!child) throw new Error('D-Bus returned an array signature without an element type');
		return `a${readSignature(child)}`;
	}
	return value.type;
}

function isSignatureNode(value: unknown): value is SignatureNode {
	return typeof value === 'object' && value !== null && 'type' in value;
}

function readPair(value: unknown, name: string): readonly [unknown, unknown] {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error(`D-Bus returned an invalid ${name}`);
	}
	return [value[0], value[1]];
}
