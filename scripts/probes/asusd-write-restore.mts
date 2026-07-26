import { setTimeout as delay } from 'node:timers/promises';
import { systemBus } from '@homebridge/dbus-native';

import {
	closeBus,
	getProperty,
	readManagedObjects,
	setProperty,
	type DbusProperty,
	type ManagedInterface,
	type ManagedObject,
} from './dbus.mts';

const ASUS_SERVICE = 'xyz.ljones.Asusd';
const CONFIRMATION_ARGUMENT = '--confirm-write';
const HARDWARE_TEST_ENVIRONMENT = 'AGENT_GLOW_HARDWARE_TEST';
const TARGET_ARGUMENT_PREFIX = '--target=';

interface WriteTarget {
	readonly name: string;
	readonly object: ManagedObject;
	readonly interface: ManagedInterface;
	readonly propertyName: string;
	readonly original: DbusProperty;
	readonly test: DbusProperty;
}

const bus = systemBus();

try {
	const targetName =
		process.argv
			.find((argument) => argument.startsWith(TARGET_ARGUMENT_PREFIX))
			?.slice(TARGET_ARGUMENT_PREFIX.length) ?? 'slash-enabled';
	const target = findWriteTarget(await readManagedObjects(bus, ASUS_SERVICE), targetName);
	const confirmed =
		process.argv.includes(CONFIRMATION_ARGUMENT) &&
		process.env[HARDWARE_TEST_ENVIRONMENT] === '1';

	console.log(
		JSON.stringify(
			{
				mode: confirmed ? 'write-and-restore' : 'dry-run',
				target: target.name,
				service: ASUS_SERVICE,
				path: target.object.path,
				interface: target.interface.name,
				property: target.propertyName,
				original: target.original,
				test: target.test,
				confirmation: confirmed
					? 'accepted'
					: `Set ${HARDWARE_TEST_ENVIRONMENT}=1 and pass ${CONFIRMATION_ARGUMENT} to execute`,
			},
			null,
			2,
		),
	);

	if (confirmed) {
		await writeAndRestore(target);
		console.log(JSON.stringify({ result: 'restored', target: target.name }));
	}
} finally {
	closeBus(bus);
}

async function writeAndRestore(target: WriteTarget): Promise<void> {
	let writeAttempted = false;
	try {
		writeAttempted = true;
		await setProperty(
			bus,
			ASUS_SERVICE,
			target.object.path,
			target.interface.name,
			target.propertyName,
			target.test,
		);
		await delay(500);
		const applied = await getProperty(
			bus,
			ASUS_SERVICE,
			target.object.path,
			target.interface.name,
			target.propertyName,
		);
		if (!sameValue(applied.value, target.test.value)) {
			throw new Error(`Write verification failed: received ${String(applied.value)}`);
		}
	} finally {
		if (writeAttempted) {
			await setProperty(
				bus,
				ASUS_SERVICE,
				target.object.path,
				target.interface.name,
				target.propertyName,
				target.original,
			);
			const restored = await getProperty(
				bus,
				ASUS_SERVICE,
				target.object.path,
				target.interface.name,
				target.propertyName,
			);
			if (!sameValue(restored.value, target.original.value)) {
				throw new Error(`Restore verification failed: received ${String(restored.value)}`);
			}
		}
	}
}

function findWriteTarget(objects: readonly ManagedObject[], targetName: string): WriteTarget {
	if (targetName === 'aura-color') return findAuraColorTarget(objects);
	if (targetName === 'slash-enabled') return findSlashEnabledTarget(objects);
	throw new Error(`Unknown write target: ${targetName}`);
}

function findSlashEnabledTarget(objects: readonly ManagedObject[]): WriteTarget {
	for (const object of objects) {
		const slash = object.interfaces.find((item) => item.name === 'xyz.ljones.Slash');
		const enabled = slash?.properties.Enabled;
		if (slash && enabled?.signature === 'b' && typeof enabled.value === 'boolean') {
			return {
				name: 'slash-enabled',
				object,
				interface: slash,
				propertyName: 'Enabled',
				original: enabled,
				test: { signature: 'b', value: !enabled.value },
			};
		}
	}
	throw new Error('No writable Slash.Enabled boolean property was discovered');
}

function findAuraColorTarget(objects: readonly ManagedObject[]): WriteTarget {
	for (const object of objects) {
		const aura = object.interfaces.find((item) => item.name === 'xyz.ljones.Aura');
		const modeData = aura?.properties.LedModeData;
		if (
			!aura ||
			modeData?.signature !== '(uu(yyy)(yyy)ss)' ||
			!Array.isArray(modeData.value) ||
			modeData.value.length !== 6
		) {
			continue;
		}

		const testValue = structuredClone(modeData.value);
		testValue[2] = [64, 0, 64];
		return {
			name: 'aura-color',
			object,
			interface: aura,
			propertyName: 'LedModeData',
			original: modeData,
			test: { signature: modeData.signature, value: testValue },
		};
	}
	throw new Error('No writable Aura.LedModeData property was discovered');
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
