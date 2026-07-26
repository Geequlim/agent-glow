export const PROTOCOL_VERSION = 1 as const;

export const PROTOCOL_LIMITS = {
	maxConcurrentRequests: 16,
	maxMessageBytes: 64 * 1024,
	maxMetadataEntries: 16,
	maxMetadataKeyLength: 64,
	maxMetadataValueLength: 256,
	maxSessionIdLength: 128,
	maxSourceLength: 64,
	maxTtlMs: 24 * 60 * 60 * 1000,
} as const;

export function isProtocolMessageWithinLimit(message: string | Uint8Array): boolean {
	const byteLength =
		typeof message === 'string'
			? new TextEncoder().encode(message).byteLength
			: message.byteLength;
	return byteLength <= PROTOCOL_LIMITS.maxMessageBytes;
}
