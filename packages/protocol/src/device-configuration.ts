import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false } as const;
const settingKey = Type.String({
	minLength: 1,
	maxLength: 128,
	pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*$',
});
const commonSettingFields = {
	key: settingKey,
	label: Type.String({ minLength: 1, maxLength: 128 }),
	group: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	description: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
};

export const DeviceConfigurationValueSchema = Type.Union([
	Type.Boolean(),
	Type.Integer(),
	Type.String({ maxLength: 128 }),
]);

export const DeviceConfigurationSettingSchema = Type.Union([
	Type.Object(
		{
			...commonSettingFields,
			kind: Type.Literal('boolean'),
			defaultValue: Type.Boolean(),
		},
		strict,
	),
	Type.Object(
		{
			...commonSettingFields,
			kind: Type.Literal('integer'),
			defaultValue: Type.Integer(),
			minimum: Type.Integer(),
			maximum: Type.Integer(),
			step: Type.Integer({ minimum: 1 }),
		},
		strict,
	),
	Type.Object(
		{
			...commonSettingFields,
			kind: Type.Literal('select'),
			defaultValue: Type.String({ minLength: 1, maxLength: 128 }),
			options: Type.Array(
				Type.Object(
					{
						value: Type.String({ minLength: 1, maxLength: 128 }),
						label: Type.String({ minLength: 1, maxLength: 128 }),
					},
					strict,
				),
				{ minItems: 1, maxItems: 128 },
			),
		},
		strict,
	),
]);

export const DeviceConfigurationValuesSchema = Type.Record(
	settingKey,
	DeviceConfigurationValueSchema,
	{ additionalProperties: false, maxProperties: 128 },
);

export const DeviceConfigurationSchema = Type.Object(
	{
		deviceId: Type.String({ minLength: 1, maxLength: 160 }),
		settings: Type.Array(DeviceConfigurationSettingSchema, { maxItems: 128 }),
		values: DeviceConfigurationValuesSchema,
	},
	strict,
);

export type DeviceConfiguration = Static<typeof DeviceConfigurationSchema>;
export type DeviceConfigurationSetting = Static<typeof DeviceConfigurationSettingSchema>;
export type DeviceConfigurationValue = Static<typeof DeviceConfigurationValueSchema>;
export type DeviceConfigurationValues = Static<typeof DeviceConfigurationValuesSchema>;
