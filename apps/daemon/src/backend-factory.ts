import { AsusdLightingBackend } from '@agent-glow/backend-asusd';
import type { LightingBackend } from '@agent-glow/core/backend';
import { FakeLightingBackend } from '@agent-glow/core/fake-backend';

export function createLightingBackend(
	environment: NodeJS.ProcessEnv = process.env,
): LightingBackend {
	const backendName = environment.AGENT_GLOW_BACKEND ?? 'fake';
	if (backendName === 'fake') return new FakeLightingBackend();
	if (backendName === 'asusd') {
		if (environment.AGENT_GLOW_HARDWARE_TEST !== '1') {
			throw new Error('Set AGENT_GLOW_HARDWARE_TEST=1 to enable the asusd backend');
		}
		const deviceKind = environment.AGENT_GLOW_ASUSD_DEVICE_KIND;
		const selectedDeviceKind =
			deviceKind === 'aura' || deviceKind === 'slash' ? deviceKind : undefined;
		if (deviceKind && !selectedDeviceKind) {
			throw new Error(`Unknown asusd device kind: ${deviceKind}`);
		}
		return new AsusdLightingBackend(undefined, selectedDeviceKind);
	}
	throw new Error(`Unknown backend: ${backendName}`);
}
