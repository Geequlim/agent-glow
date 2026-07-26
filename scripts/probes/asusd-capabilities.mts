import { systemBus } from '@homebridge/dbus-native';

import { closeBus, readManagedObjects } from './dbus.mts';

const ASUS_SERVICE = 'xyz.ljones.Asusd';
const LIGHTING_INTERFACES = new Set(['xyz.ljones.Aura', 'xyz.ljones.Slash']);

const bus = systemBus();

try {
	const managedObjects = await readManagedObjects(bus, ASUS_SERVICE);
	const devices = managedObjects
		.map((object) => ({
			path: object.path,
			interfaces: object.interfaces
				.filter((item) => LIGHTING_INTERFACES.has(item.name))
				.map((item) => ({
					...item,
					properties: Object.fromEntries(
						Object.entries(item.properties).sort(([left], [right]) =>
							left.localeCompare(right),
						),
					),
				}))
				.sort((left, right) => left.name.localeCompare(right.name)),
		}))
		.filter((object) => object.interfaces.length > 0);

	if (devices.length === 0) {
		throw new Error(`${ASUS_SERVICE} did not expose Aura or Slash interfaces`);
	}

	console.log(
		JSON.stringify(
			{
				service: ASUS_SERVICE,
				devices,
			},
			null,
			2,
		),
	);
} finally {
	closeBus(bus);
}
