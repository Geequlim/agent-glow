import type { DeviceDescriptor } from '@agent-glow/protocol/device';
import type {
	DeviceConfiguration,
	DeviceConfigurationValues,
} from '@agent-glow/protocol/device-configuration';
import type { SemanticState } from '@agent-glow/protocol/semantic-state';

export interface RgbColor {
	readonly blue: number;
	readonly green: number;
	readonly red: number;
}

export interface StaticVisualState {
	readonly color: RgbColor;
	readonly hardwareIntensity: number;
	readonly intensity: number;
	readonly semanticState: SemanticState;
}

export interface BackendSnapshot {
	readonly backendId: string;
	readonly deviceId: string;
	readonly value: unknown;
}

export interface BackendApplyResult {
	readonly applied: StaticVisualState;
	readonly degraded: boolean;
	readonly details?: {
		readonly applied: Readonly<Record<string, boolean | number | string>>;
		readonly requested: Readonly<Record<string, boolean | number | string>>;
	};
	readonly reason?: string;
	readonly requested: StaticVisualState;
}

export interface LightingBackend {
	readonly id: string;

	getHealth(): 'healthy' | 'degraded' | 'unavailable';
	discoverDevices(): Promise<readonly DeviceDescriptor[]>;
	getDeviceConfiguration(deviceId: string): Promise<DeviceConfiguration>;
	updateDeviceConfiguration(deviceId: string, values: DeviceConfigurationValues): Promise<void>;
	captureSnapshot(deviceId: string): Promise<BackendSnapshot>;
	applyVisualState(deviceId: string, visualState: StaticVisualState): Promise<BackendApplyResult>;
	restoreSnapshot(snapshot: BackendSnapshot): Promise<void>;
	close(): Promise<void>;
}
