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

export interface AsusdTransport {
	readManagedObjects(): Promise<readonly ManagedObject[]>;
	callMethod(path: string, interfaceName: string, methodName: string): Promise<unknown>;
	getProperty(path: string, interfaceName: string, propertyName: string): Promise<DbusProperty>;
	setProperty(
		path: string,
		interfaceName: string,
		propertyName: string,
		property: DbusProperty,
	): Promise<void>;
	close(): void;
}
