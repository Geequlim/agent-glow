import { describe, expect, it, vi } from 'vitest';

import { SystemdServiceClient } from '../src/service-client.js';

describe('SystemdServiceClient', () => {
	it('maps the single switch to enable/disable --now', async () => {
		const run = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' }));
		const client = new SystemdServiceClient(run);

		await client.setEnabled(true);
		await client.setEnabled(false);

		expect(run).toHaveBeenNthCalledWith(1, 'systemctl', [
			'--user',
			'enable',
			'--now',
			'agent-glow.service',
		]);
		expect(run).toHaveBeenNthCalledWith(2, 'systemctl', [
			'--user',
			'disable',
			'--now',
			'agent-glow.service',
		]);
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
