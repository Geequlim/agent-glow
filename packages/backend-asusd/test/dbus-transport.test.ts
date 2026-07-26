import { EventEmitter } from 'node:events';

import type { DBusInterface, MessageBus } from '@homebridge/dbus-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DbusAsusdTransport } from '../src/dbus-transport.js';

afterEach(() => vi.useRealTimers());

describe('DbusAsusdTransport lifecycle', () => {
	it('bounds a D-Bus request that never returns', async () => {
		vi.useFakeTimers();
		const transport = new DbusAsusdTransport(createBus().bus);
		const request = transport.getProperty('/device', 'example.Interface', 'Value');
		const rejection = expect(request).rejects.toThrow('D-Bus request timed out');

		await vi.advanceTimersByTimeAsync(1000);

		await rejection;
	});

	it('reports service owner and sleep signals and removes its listeners', () => {
		const fixture = createBus();
		const transport = new DbusAsusdTransport(fixture.bus);
		const events: unknown[] = [];
		const stop = transport.watchLifecycle((event) => events.push(event));

		fixture.dbus.emit('NameOwnerChanged', 'xyz.ljones.Asusd', ':1.20', '');
		fixture.dbus.emit('NameOwnerChanged', 'xyz.ljones.Asusd', '', ':1.21');
		fixture.login.emit('PrepareForSleep', true);
		fixture.login.emit('PrepareForSleep', false);
		stop();
		fixture.login.emit('PrepareForSleep', true);

		expect(events).toEqual([
			{ type: 'availability', available: false },
			{ type: 'availability', available: true },
			{ type: 'sleep', sleeping: true },
			{ type: 'sleep', sleeping: false },
		]);
	});
});

function createBus(): {
	readonly bus: MessageBus;
	readonly dbus: EventEmitter;
	readonly login: EventEmitter;
} {
	const dbus = new EventEmitter();
	const login = new EventEmitter();
	const bus = {
		connection: { stream: { destroy: vi.fn() } },
		invoke: vi.fn(),
		getService: (name: string) => ({
			getInterface: (
				_path: string,
				_interfaceName: string,
				callback: (error: null, dbusInterface: DBusInterface) => void,
			) => callback(null, (name === 'org.freedesktop.DBus' ? dbus : login) as DBusInterface),
		}),
	} as unknown as MessageBus;
	return { bus, dbus, login };
}
