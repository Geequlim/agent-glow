import { describe, expect, it } from 'vitest';

import { isProtocolMessageWithinLimit, PROTOCOL_LIMITS } from '../src/limits.js';

describe('isProtocolMessageWithinLimit', () => {
	it('counts UTF-8 bytes rather than JavaScript characters', () => {
		const exactLimit = '灯'.repeat(Math.floor(PROTOCOL_LIMITS.maxMessageBytes / 3));
		const overLimit = `${exactLimit}灯`;

		expect(isProtocolMessageWithinLimit(exactLimit)).toBe(true);
		expect(isProtocolMessageWithinLimit(overLimit)).toBe(false);
	});
});
