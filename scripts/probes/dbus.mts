import type { MessageBus } from '@homebridge/dbus-native';

interface DbusMessage {
	readonly destination: string;
	readonly path: string;
	readonly interface: string;
	readonly member: string;
	readonly signature?: string;
	readonly body?: readonly unknown[];
}

export interface DbusProperty {
	readonly signature: string;
	readonly value: unknown;
}

export interface ManagedInterface {
	readonly name: string;
	readonly properties: Readonly<Record<string, DbusProperty>>;
}

export interface ManagedObject {
	readonly path: string;
	readonly interfaces: readonly ManagedInterface[];
}

interface SignatureNode {
	readonly type: string;
	readonly child?: readonly SignatureNode[];
}

export function invoke(bus: MessageBus, message: DbusMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		bus.invoke(message, (error, value: unknown) => {
			if (error) {
				reject(new Error(`${error.name}: ${String(error.message)}`));
				return;
			}
			resolve(value);
		});
	});
}

export function closeBus(bus: MessageBus): void {
	bus.connection.stream.destroy();
}

export async function readManagedObjects(
	bus: MessageBus,
	destination: string,
): Promise<readonly ManagedObject[]> {
	const rawObjects = await invoke(bus, {
		destination,
		path: '/',
		interface: 'org.freedesktop.DBus.ObjectManager',
		member: 'GetManagedObjects',
	});
	if (!Array.isArray(rawObjects)) throw new Error('ObjectManager returned a non-array value');

	return rawObjects.map(readManagedObject);
}

export async function setProperty(
	bus: MessageBus,
	destination: string,
	path: string,
	interfaceName: string,
	propertyName: string,
	property: DbusProperty,
): Promise<void> {
	await invoke(bus, {
		destination,
		path,
		interface: 'org.freedesktop.DBus.Properties',
		member: 'Set',
		signature: 'ssv',
		body: [interfaceName, propertyName, [property.signature, property.value]],
	});
}

export async function getProperty(
	bus: MessageBus,
	destination: string,
	path: string,
	interfaceName: string,
	propertyName: string,
): Promise<DbusProperty> {
	const value = await invoke(bus, {
		destination,
		path,
		interface: 'org.freedesktop.DBus.Properties',
		member: 'Get',
		signature: 'ss',
		body: [interfaceName, propertyName],
	});
	return readVariant(value);
}

function readManagedObject(value: unknown): ManagedObject {
	const [path, rawInterfaces] = readPair(value, 'managed object');
	if (typeof path !== 'string' || !Array.isArray(rawInterfaces)) {
		throw new Error('ObjectManager returned an invalid object entry');
	}

	return {
		path,
		interfaces: rawInterfaces.map(readManagedInterface),
	};
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

	return {
		signature: readSignature(rawSignature[0]),
		value: rawValues[0],
	};
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
