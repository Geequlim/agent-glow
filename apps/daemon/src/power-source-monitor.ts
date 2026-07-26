import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const EXTERNAL_POWER_TYPES = new Set(['Mains', 'USB', 'USB_C', 'Wireless']);
const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface PowerSourceMonitor {
	isOnBattery(): Promise<boolean>;
	watch(listener: (onBattery: boolean) => void): () => void;
}

export class SysfsPowerSourceMonitor implements PowerSourceMonitor {
	readonly #pollIntervalMs: number;
	readonly #root: string;

	constructor(root = '/sys/class/power_supply', pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
		this.#root = root;
		this.#pollIntervalMs = pollIntervalMs;
	}

	async isOnBattery(): Promise<boolean> {
		const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
		const supplies = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map(async (entry) => {
					const directory = path.join(this.#root, entry.name);
					const type = await readValue(path.join(directory, 'type'));
					return {
						type,
						online: await readValue(path.join(directory, 'online')),
						status: await readValue(path.join(directory, 'status')),
					};
				}),
		);
		const batteries = supplies.filter((supply) => supply.type === 'Battery');
		if (batteries.length === 0) return false;

		const external = supplies.filter((supply) => EXTERNAL_POWER_TYPES.has(supply.type));
		if (external.length > 0) return !external.some((supply) => supply.online === '1');
		return batteries.some((battery) => battery.status === 'Discharging');
	}

	watch(listener: (onBattery: boolean) => void): () => void {
		let stopped = false;
		let reading = false;
		let previous: boolean | undefined;
		const poll = async (): Promise<void> => {
			if (stopped || reading) return;
			reading = true;
			try {
				const current = await this.isOnBattery();
				if (previous === undefined || current !== previous) listener(current);
				previous = current;
			} finally {
				reading = false;
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), this.#pollIntervalMs);
		timer.unref();
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}
}

async function readValue(filePath: string): Promise<string> {
	return readFile(filePath, 'utf8')
		.then((value) => value.trim())
		.catch(() => '');
}
