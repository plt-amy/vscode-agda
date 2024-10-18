/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Event, EventEmitter } from 'vscode';

import type { Readable, Writable } from './api';
import { encodeText, createCompletablePromise, CompletablePromise } from './support';

export class DestroyError extends Error {
	constructor() {
		super('Pipe got destroyed');
	}
}

const BufferSize = 16384;

export class WritableStream implements Writable{

	protected chunks: Uint8Array[];
	protected fillLevel: number;

	private awaitForFillLevel: { fillLevel: number; promise: CompletablePromise<void> }[];
	private awaitForData: CompletablePromise<void>[];

	constructor(private readonly readableBuffer: BigInt64Array) {
		this.chunks = [];
		this.fillLevel = 0;
		this.awaitForFillLevel = [];
		this.awaitForData = [];
	}

	public async write(chunk: Uint8Array | string): Promise<void> {
		if(typeof chunk === 'string') chunk = encodeText(chunk);
		// We have enough space
		if (this.fillLevel + chunk.byteLength <= BufferSize) {
			this.chunks.push(chunk);
			this.fillLevel += chunk.byteLength;
			this.signalData();
			return;
		}
		// Wait for the necessary space.
		const targetFillLevel = Math.max(0, BufferSize - chunk.byteLength);
		try {
			await this.awaitFillLevel(targetFillLevel);
			if (this.fillLevel > targetFillLevel) {
				throw new Error(`Invalid state: fillLevel should be <= ${targetFillLevel}`);
			}
			this.chunks.push(chunk);
			this.fillLevel += chunk.byteLength;
			this.signalData();
			return;
		} catch (error) {
			if (error instanceof DestroyError) {
				return;
			}
			throw error;
		}
	}

	public async read(size?: number): Promise<Uint8Array> {
		const maxBytes = size ?? undefined;
		if (this.chunks.length === 0) {
			try {
				await this.awaitData();
			} catch (error) {
				if (error instanceof DestroyError) {
					return new Uint8Array(0);
				}
				throw error;
			}
		}
		if (this.chunks.length === 0) {
			throw new Error('Invalid state: no bytes available after awaiting data');
		}
		// No max bytes or all data fits into the result.
		if (maxBytes === undefined || maxBytes > this.fillLevel) {
			const result = new Uint8Array(this.fillLevel);
			let offset = 0;
			for (const chunk of this.chunks) {
				result.set(chunk, offset);
				offset += chunk.byteLength;
			}
			this.chunks = [];
			this.fillLevel = 0;
			this.signalSpace();
			return result;
		}

		const chunk = this.chunks[0];
		// The first chunk is bigger than the maxBytes. Although not optimal we need
		// to split it up
		if (chunk.byteLength > maxBytes) {
			const result = chunk.subarray(0, maxBytes);
			this.chunks[0] = chunk.subarray(maxBytes);
			this.fillLevel -= maxBytes;
			this.signalSpace();
			return result;
		} else {
			console.warn("This code is definitely wrong!!");
			let resultSize = chunk.byteLength;
			for (let i = 1; i < this.chunks.length; i++) {
				if (resultSize + this.chunks[i].byteLength > maxBytes) {
					break;
				}
			}
			const result = new Uint8Array(resultSize);
			let offset = 0;
			for (let i = 0; i < this.chunks.length; i++) {
				const chunk = this.chunks.shift()!;
				if (offset + chunk.byteLength > maxBytes) {
					break;
				}
				result.set(chunk, offset);
				offset += chunk.byteLength;
				this.fillLevel -= chunk.byteLength;
			}
			this.signalSpace();
			return result;
		}
	}

	public async waitRead(): Promise<bigint> {
		while (this.chunks.length === 0) {
			try {
				if (this.awaitForData.length === 0) {
					await this.awaitData();
				} else {
					if (this.awaitForData.length > 1) console.warn("Multiple waiters", this.awaitForData);
					await this.awaitForData[0].promise;
				}
			} catch (error) {
				if (error instanceof DestroyError) {
					return 0n;
				}
				throw error;
			}
		}

		let size = 0n;
		for (const chunk of this.chunks) size += BigInt(chunk.byteLength);
		return size;
	}

	public destroy(): void {
		this.chunks = [];
		this.fillLevel = 0;
		const error = new DestroyError();
		for (const { promise } of this.awaitForFillLevel) {
			promise.reject(error);
		}
		this.awaitForFillLevel = [];
		for (const promise of this.awaitForData) {
			promise.reject(error);
		}
	}

	private awaitFillLevel(targetFillLevel: number): Promise<void> {
		const result = createCompletablePromise<void>();
		this.awaitForFillLevel.push({ fillLevel: targetFillLevel, promise: result });
		return result.promise;
	}

	private awaitData(): Promise<void> {
		const result = createCompletablePromise<void>();
		this.awaitForData.push(result);
		return result.promise;
	}

	private signal(): void {
		Atomics.store(this.readableBuffer, 0, BigInt(this.fillLevel));
		Atomics.notify(this.readableBuffer, 0);
	}

	protected signalSpace(): void {
		this.signal();
		if (this.awaitForFillLevel.length === 0) {
			return;
		}
		const { fillLevel, promise } = this.awaitForFillLevel[0];
		// Not enough space.
		if (this.fillLevel > fillLevel) {
			return;
		}
		this.awaitForFillLevel.shift();
		promise.resolve();
	}

	protected signalData(): void {
		this.signal();
		if (this.awaitForData.length === 0) {
			return;
		}
		const promise = this.awaitForData.shift()!;
		promise.resolve();
	}

}

export class ReadableStream implements Readable {
	private readonly _onData: EventEmitter<Uint8Array>;
	private readonly _onDataEvent: Event<Uint8Array>;

	constructor() {
		this._onData = new EventEmitter();
		this._onDataEvent = (listener, thisArgs?, disposables?) => {
			return this._onData.event(listener, thisArgs, disposables);
		};
	}

	public get onData(): Event<Uint8Array> {
		return this._onDataEvent;
	}

	public destroy(): void {
		this._onData.dispose();
	}

	public async write(chunk: Uint8Array): Promise<void> {
		this._onData.fire(chunk);
	}
}
