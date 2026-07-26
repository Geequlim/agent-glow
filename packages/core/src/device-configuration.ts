import type {
	DeviceConfiguration,
	DeviceConfigurationSetting,
	DeviceConfigurationValues,
} from '@agent-glow/protocol/device-configuration';
import {
	DeviceConfigurationSchema,
	DeviceConfigurationValuesSchema,
} from '@agent-glow/protocol/device-configuration';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export function mergeDeviceConfiguration(
	configuration: DeviceConfiguration,
	update: DeviceConfigurationValues,
): DeviceConfiguration {
	if (!Value.Check(DeviceConfigurationSchema, configuration)) {
		throw new Error('Backend registered an invalid device configuration');
	}
	if (!Value.Check(DeviceConfigurationValuesSchema, update)) {
		throw new Error('Invalid device configuration update');
	}

	const settings = new Map(
		configuration.settings.map((setting) => [setting.key, setting] as const),
	);
	if (settings.size !== configuration.settings.length) {
		throw new Error('Backend registered duplicate device configuration settings');
	}
	for (const setting of settings.values()) {
		assertSettingValue(setting, setting.defaultValue);
		if (!(setting.key in configuration.values)) {
			throw new Error(`Backend omitted device configuration value: ${setting.key}`);
		}
		assertSettingValue(setting, configuration.values[setting.key]);
	}
	for (const key of Object.keys(configuration.values)) {
		if (!settings.has(key)) {
			throw new Error(`Backend returned an unknown device configuration value: ${key}`);
		}
	}
	const values: DeviceConfigurationValues = { ...configuration.values };

	for (const [key, value] of Object.entries(update)) {
		const setting = settings.get(key);
		if (!setting) throw new Error(`Unknown device configuration setting: ${key}`);
		assertSettingValue(setting, value);
		values[key] = value;
	}

	return { ...configuration, values };
}

function assertSettingValue(
	setting: DeviceConfigurationSetting,
	value: DeviceConfigurationValues[string],
): void {
	const schema =
		setting.kind === 'boolean'
			? Type.Boolean()
			: setting.kind === 'integer'
				? Type.Integer({
						minimum: setting.minimum,
						maximum: setting.maximum,
						multipleOf: setting.step,
					})
				: Type.Union(setting.options.map((option) => Type.Literal(option.value)));
	if (!Value.Check(schema, value)) invalidValue(setting.key);
}

function invalidValue(key: string): never {
	throw new Error(`Invalid value for device configuration setting: ${key}`);
}
