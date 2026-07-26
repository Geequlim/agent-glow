import { createConnection } from 'node:net';

import { isProtocolMessageWithinLimit } from '@agent-glow/protocol/limits';

import { resolveSocketPath } from './socket-path.js';

const REQUEST_TIMEOUT_MS = 200;

export type RpcRequestFunction = (method: string, params: unknown) => Promise<unknown>;

export function sendRpcRequest(
	method: string,
	params: unknown,
	socketPath = resolveSocketPath(),
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = '';
		let settled = false;

		const finish = (error?: Error, result?: unknown): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve(result);
		};

		socket.setEncoding('utf8');
		socket.setTimeout(REQUEST_TIMEOUT_MS);
		socket.once('connect', () => {
			socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
		});
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			if (!isProtocolMessageWithinLimit(buffer)) {
				finish(new Error('Daemon response exceeds message limit'));
				return;
			}

			const newlineIndex = buffer.indexOf('\n');
			if (newlineIndex < 0) return;

			try {
				const response: unknown = JSON.parse(buffer.slice(0, newlineIndex));
				if (!isRpcResponse(response)) {
					finish(new Error('Daemon returned an invalid response'));
				} else if (response.error) {
					finish(new Error(response.error.message));
				} else {
					finish(undefined, response.result);
				}
			} catch {
				finish(new Error('Daemon returned malformed JSON'));
			}
		});
		socket.once('timeout', () => finish(new Error('Daemon request timed out')));
		socket.once('error', (error) => finish(error));
	});
}

interface RpcResponse {
	readonly error?: { readonly message: string };
	readonly result?: unknown;
}

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!value || typeof value !== 'object') return false;
	if ('error' in value) {
		const error = value.error;
		return (
			typeof error === 'object' &&
			error !== null &&
			'message' in error &&
			typeof error.message === 'string'
		);
	}
	return 'result' in value;
}
