import { systemBus, type MessageBus } from '@homebridge/dbus-native';

import type { AsusdTransport, DbusProperty, ManagedInterface, ManagedObject } from './transport.js';

const ASUS_SERVICE = 'xyz.ljones.Asusd';

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

	close(): void {
		this.#bus.connection.stream.destroy();
	}
}

function invoke(bus: MessageBus, message: DbusMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		bus.invoke(message, (error, ...values: unknown[]) => {
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
