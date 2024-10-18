
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */


export const realTime = (): bigint => BigInt(Date.now()) * 1000000n;
export const monoTime = (): bigint => {
	// digits are ms, decimal places are fractions of ms.
	const now = self.performance.timeOrigin + self.performance.now();
	const ms = Math.trunc(now);
	const msf = now - ms;
	// We need to convert everything into nanoseconds
	return BigInt(ms) * 1000000n + BigInt(Math.round(msf * 1000000));
};

const decoder = new TextDecoder();

/**
 * Decode a buffer containing utf-8 text to a string.
 *
 * This handles trying to decode text from shared buffers. By default, this is
 * not allowed.
 */
export const decodeText = (input: Uint8Array): string => {
	if (input === undefined) {
		return decoder.decode(input);
	} else {
		if (input.buffer instanceof SharedArrayBuffer) {
			return decoder.decode(input.slice(0));
		} else {
			return decoder.decode(input);
		}
	}
};

const encoder = new TextEncoder();

/**
 * Convert a string to a utf-8 encoded byte array.
 */
export const encodeText = (input: string): Uint8Array => encoder.encode(input);

export interface CompletablePromise<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: any) => void;
}

export const createCompletablePromise = <T>(): CompletablePromise<T> => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: any) => void;
	const promise: Promise<T> = new Promise<T>(($resolve, $reject) => {
		resolve = $resolve;
		reject = $reject;
	});
	return { promise, resolve, reject };
}
