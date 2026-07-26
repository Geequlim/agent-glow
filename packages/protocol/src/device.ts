import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false } as const;

export const DeviceCapabilitySchema = Type.Union([
	Type.Literal('power'),
	Type.Literal('static_color'),
	Type.Literal('brightness'),
	Type.Literal('firmware_effect'),
]);

export const DeviceDescriptorSchema = Type.Object(
	{
		id: Type.String({
			pattern: '^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
		}),
		name: Type.String({ minLength: 1, maxLength: 128 }),
		description: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		capabilities: Type.Array(DeviceCapabilitySchema, {
			maxItems: 16,
			uniqueItems: true,
		}),
	},
	strict,
);

export type DeviceCapability = Static<typeof DeviceCapabilitySchema>;
export type DeviceDescriptor = Static<typeof DeviceDescriptorSchema>;
