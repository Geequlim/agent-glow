import { describe, expect, it, vi } from 'vitest';

import { SystemdServiceClient } from '../src/service-client.js';

describe('SystemdServiceClient', () => {
	it('unmasks before enabling and disables immediately', async () => {
		const run = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' }));
		const client = new SystemdServiceClient(run);

		await client.setEnabled(true);
		await client.setEnabled(false);

		expect(run).toHaveBeenNthCalledWith(1, 'systemctl', [
			'--user',
			'unmask',
			'agent-glow.service',
		]);
		expect(run).toHaveBeenNthCalledWith(2, 'systemctl', [
			'--user',
			'enable',
			'--now',
			'agent-glow.service',
		]);
		expect(run).toHaveBeenNthCalledWith(3, 'systemctl', [
			'--user',
			'disable',
			'--now',
			'agent-glow.service',
		]);
	});

	it('does not enable when unmasking fails', async () => {
		const run = vi.fn(async () => ({
			exitCode: 1,
			stderr: 'unmask failed',
			stdout: '',
		}));
		const client = new SystemdServiceClient(run);

		await expect(client.setEnabled(true)).rejects.toThrow('unmask failed');
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('reads running and enabled from one status query', async () => {
		const client = new SystemdServiceClient(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'ActiveState=active\nUnitFileState=enabled\n',
		}));

		await expect(client.getStatus()).resolves.toEqual({ enabled: true, running: true });
	});
});
