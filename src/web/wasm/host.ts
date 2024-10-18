/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { cstring, ptr, size, u32, u64, u8 } from './baseTypes';
import { Offsets, WorkerMessage } from './connection';
import { monoTime, realTime } from './support';
import { TraceMessage } from './trace';
import {
	args_get, args_sizes_get, ciovec, clockid, Clockid, dircookie, dirent, environ_get, environ_sizes_get, errno, Errno,
	event, Event, Eventtype, exitcode, fd, fd_close, fd_fdstat_get, fd_fdstat_set_flags, fd_filestat_get, fd_filestat_set_size,
	fd_prestat_dir_name, fd_prestat_get, fd_read, fd_readdir, fd_seek, fd_write, fdflags, fdstat, filedelta, filesize,
	filestat, iovec, lookupflags, oflags, path_create_directory, path_filestat_get, path_open, path_readlink, path_rename,
	path_unlink_file, poll_oneoff, prestat, proc_exit, rights, Subclockflags, subscription, Subscription, Subscription_clock,
	Subscription_fd_readwrite, Subscription_u, timestamp, WASI, WasiError, whence
} from './wasi';
import { MemoryTransfer, ParamKind, ReverseTransfer, WasiFunction, WasiFunctions, WasiFunctionSignature } from './wasiMeta';

export abstract class HostConnection {

	private readonly timeout: number | undefined;

	constructor(timeout?: number) {
		this.timeout = timeout;
	}

	public abstract postMessage(message: WorkerMessage): any;

	public abstract destroy(): void;

	public call(func: WasiFunction, args: (number | bigint)[], wasmMemory: ArrayBuffer, transfers?: MemoryTransfer): errno {
		const signature = func.signature;
		if (signature.params.length !== args.length) {
			throw new WasiError(Errno.inval);
		}
		const [paramBuffer, resultBuffer, reverseTransfer] = this.createCallArrays(func.name, signature, args, wasmMemory, transfers);
		const result = this.doCall(paramBuffer, resultBuffer);
		if (result !== Errno.success || resultBuffer === wasmMemory || reverseTransfer === undefined) {
			return result;
		}

		// Copy the results back into the WASM memory.
		const targetMemory = new Uint8Array(wasmMemory);
		if (ReverseTransfer.isCustom(reverseTransfer)) {
			reverseTransfer.copy();
		} else if (ReverseTransfer.isArguments(reverseTransfer)) {
			let reverseIndex = 0;
			for (let i = 0; i < args.length; i++) {
				const param = signature.params[i];
				if (param.kind !== ParamKind.ptr) {
					continue;
				}
				const reverse = reverseTransfer[reverseIndex++];
				if (reverse !== undefined) {
					if (Array.isArray(reverse)) {
						for (const single of reverse) {
							targetMemory.set(new Uint8Array(resultBuffer, single.from, single.size), single.to);
						}
					} else {
						targetMemory.set(new Uint8Array(resultBuffer, reverse.from, reverse.size), reverse.to);
					}
				}
			}
		}
		return result;
	}

	private doCall(paramBuffer: SharedArrayBuffer, resultBuffer: SharedArrayBuffer): errno {
		const sync = new Int32Array(paramBuffer, Offsets.lock_index, 1);
		Atomics.store(sync, 0, 0);
		this.postMessage([paramBuffer, resultBuffer]);

		// Wait for the answer
		const result = Atomics.wait(sync, 0, 0, this.timeout);
		switch (result) {
			case 'timed-out':
				return Errno.timedout;
			case 'not-equal':
				const value = Atomics.load(sync, 0);
				// If the value === 1 the service has already
				// provided the result. Otherwise we actually
				// don't know what happened :-(.
				if (value !== 1) {
					return Errno.nosys;
				}
		}

		return new Uint16Array(paramBuffer, Offsets.errno_index, 1)[0];
	}

	private createCallArrays(name: string, signature: WasiFunctionSignature, args: (number | bigint)[], wasmMemory: ArrayBuffer, transfer: MemoryTransfer | undefined): [SharedArrayBuffer, SharedArrayBuffer, ReverseTransfer | undefined] {
		const paramBuffer = new SharedArrayBuffer(Offsets.header_size + signature.memorySize);
		const paramView = new DataView(paramBuffer);
		paramView.setUint32(Offsets.method_index, WasiFunctions.getIndex(name), true);
		// The WASM memory is shared so we can share it with the kernel thread.
		// So no need to copy data into yet another shared array.
		if (wasmMemory instanceof SharedArrayBuffer) {
			let offset = Offsets.header_size;
			for (let i = 0; i < args.length; i++) {
				const param = signature.params[i];
				param.write(paramView, offset, args[i] as (number & bigint));
				offset += param.size;
			}
			return [paramBuffer, wasmMemory, []];
		} else {
			const resultBuffer = new SharedArrayBuffer(transfer?.size ?? 0);
			let reverse: ReverseTransfer | undefined = undefined;
			let offset = Offsets.header_size;
			let result_ptr = 0;
			if (MemoryTransfer.isCustom(transfer)) {
				reverse = transfer.copy(wasmMemory, args, paramBuffer, offset, resultBuffer);
			} else if (MemoryTransfer.isArguments(transfer)) {
				let transferIndex = 0;
				reverse = [];
				for (let i = 0; i < args.length; i++) {
					const param = signature.params[i];
					if (param.kind === ParamKind.ptr) {
						param.write(paramView, offset, result_ptr);
						const transferItem = transfer?.items[transferIndex++];
						if (transferItem === undefined) {
							throw new WasiError(Errno.inval);
						}
						reverse.push(transferItem.copy(wasmMemory, args[i] as number, resultBuffer, result_ptr));
						result_ptr += transferItem.memorySize;
					} else {
						param.write(paramView, offset, args[i] as (number & bigint));
					}
					offset += param.size;
				}
			} else {
				// Only copy params
				for (let i = 0; i < args.length; i++) {
					const param = signature.params[i];
					param.write(paramView, offset, args[i] as (number & bigint));
					offset += param.size;
				}
			}
			return [paramBuffer, resultBuffer, reverse];
		}
	}
}

declare namespace WebAssembly {

	interface Global {
		value: any;
		valueOf(): any;
	}
	interface Table {
		readonly length: number;
		get(index: number): any;
		grow(delta: number, value?: any): number;
		set(index: number, value?: any): void;
	}
	interface Memory {
		readonly buffer: ArrayBuffer;
		grow(delta: number): number;
	}
	type ExportValue = Function | Global | Memory | Table;

	interface Instance {
		readonly exports: Record<string, ExportValue>;
	}

	var Instance: {
		prototype: Instance;
		new(): Instance;
	};
}

export interface WasiHost extends WASI {
	initialize: (instOrMemory: WebAssembly.Instance, sharedMemory: SharedArrayBuffer) => void;
	memory: () => ArrayBuffer;
}

export namespace WasiHost {
	export function create(connection: HostConnection): WasiHost {

		let $instance: WebAssembly.Instance | undefined;
		let $memory: WebAssembly.Memory | undefined;
		let $sharedMemory: BigInt64Array | undefined;
		const args_size = { count: 0, bufferSize: 0 };
		const environ_size = { count: 0, bufferSize: 0 };

		const thread_start = monoTime();

		function memory(): ArrayBuffer {
			if ($memory !== undefined) {
				return $memory.buffer;
			}
			if ($instance === undefined || $instance.exports.memory === undefined) {
				throw new Error(`WASI layer is not initialized. Missing WebAssembly instance or memory module.`);
			}
			return ($instance.exports.memory as WebAssembly.Memory).buffer;
		}

		function memoryView(): DataView {
			if ($memory !== undefined) {
				return new DataView($memory.buffer);
			}
			if ($instance === undefined || $instance.exports.memory === undefined) {
				throw new Error(`WASI layer is not initialized. Missing WebAssembly instance or memory module.`);
			}
			return new DataView(($instance.exports.memory as WebAssembly.Memory).buffer);
		}

		function handleError(error: any, def: errno = Errno.badf): errno {
			if (error instanceof WasiError) {
				return error.errno;
			}
			return def;
		}

		const wasi: WasiHost = {
			initialize: (instOrMemory: WebAssembly.Instance, sharedMemory: SharedArrayBuffer): void => {
				$instance = instOrMemory;
				$memory = undefined;
				$sharedMemory = new BigInt64Array(sharedMemory);
			},
			memory: (): ArrayBuffer => {
				return memory();
			},
			args_sizes_get: (argvCount_ptr: ptr<u32>, argvBufSize_ptr: ptr<u32>): errno => {
				try {
					args_size.count = 0; args_size.bufferSize = 0;
					const result = connection.call(args_sizes_get, [argvCount_ptr, argvBufSize_ptr], memory(), args_sizes_get.transfers());
					if (result === Errno.success) {
						const view = memoryView();
						args_size.count = view.getUint32(argvCount_ptr, true);
						args_size.bufferSize = view.getUint32(argvBufSize_ptr, true);
					}
					return result;
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			args_get: (argv_ptr: ptr<ptr<cstring>[]>, argvBuf_ptr: ptr<cstring>): errno => {
				if (args_size.count === 0 || args_size.bufferSize === 0) {
					return Errno.inval;
				}
				try {
					return connection.call(args_get, [argv_ptr, argvBuf_ptr], memory(), args_get.transfers(memoryView(), args_size.count, args_size.bufferSize));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			clock_res_get: (id: clockid, timestamp_ptr: ptr<u64>): errno => {
				const view = memoryView();
				switch (id) {
					case Clockid.realtime:
					case Clockid.monotonic:
					case Clockid.process_cputime_id:
					case Clockid.thread_cputime_id:
						view.setBigUint64(timestamp_ptr, 1n, true);
						return Errno.success;
					default:
						view.setBigUint64(timestamp_ptr, 0n, true);
						return Errno.inval;
				}
			},
			clock_time_get: (id: clockid, _precision: timestamp, timestamp_ptr: ptr<u64>): errno => {
				let time;
				switch (id) {
					case Clockid.realtime:
						time = realTime();
						break;
					case Clockid.monotonic:
						time = monoTime();
						break;
					case Clockid.process_cputime_id:
					case Clockid.thread_cputime_id:
						time = monoTime() - thread_start;
						break;
					default:
						return Errno.inval;
				}

				memoryView().setBigUint64(timestamp_ptr, time, true);
				return Errno.success;
			},
			environ_sizes_get: (environCount_ptr: ptr<u32>, environBufSize_ptr: ptr<u32>): errno => {
				try {
					environ_size.count = 0; environ_size.bufferSize = 0;
					const result = connection.call(environ_sizes_get, [environCount_ptr, environBufSize_ptr], memory(), environ_sizes_get.transfers());
					if (result === Errno.success) {
						const view = memoryView();
						environ_size.count = view.getUint32(environCount_ptr, true);
						environ_size.bufferSize = view.getUint32(environBufSize_ptr, true);
					}
					return result;
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			environ_get: (environ_ptr: ptr<u32>, environBuf_ptr: ptr<cstring>): errno => {
				if (environ_size.count === 0 || environ_size.bufferSize === 0) {
					return Errno.inval;
				}
				try {
					return connection.call(environ_get, [environ_ptr, environBuf_ptr], memory(), environ_get.transfers(memoryView(), environ_size.count, environ_size.bufferSize));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_close: (fd: fd): errno => {
				try {
					return connection.call(fd_close, [fd], memory());
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_fdstat_get: (fd: fd, fdstat_ptr: ptr<fdstat>): errno => {
				try {
					return connection.call(fd_fdstat_get, [fd, fdstat_ptr], memory(), fd_fdstat_get.transfers());
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_fdstat_set_flags: (fd: fd, fdflags: fdflags): errno => {
				try {
					return connection.call(fd_fdstat_set_flags, [fd, fdflags], memory());
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_filestat_get: (fd: fd, filestat_ptr: ptr<filestat>): errno => {
				try {
					return connection.call(fd_filestat_get, [fd, filestat_ptr], memory(), fd_filestat_get.transfers());
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_filestat_set_size: (fd: fd, size: filesize): errno => {
				try {
					return connection.call(fd_filestat_set_size, [fd, size], memory());
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_prestat_get: (fd: fd, bufPtr: ptr<prestat>): errno => {
				try {
					return connection.call(fd_prestat_get, [fd, bufPtr], memory(), fd_prestat_get.transfers());
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_prestat_dir_name: (fd: fd, pathPtr: ptr<u8[]>, pathLen: size): errno => {
				try {
					return connection.call(fd_prestat_dir_name, [fd, pathPtr, pathLen], memory(), fd_prestat_dir_name.transfers(memoryView(), pathPtr, pathLen));
				}
				catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_read: (fd: fd, iovs_ptr: ptr<iovec>, iovs_len: u32, bytesRead_ptr: ptr<u32>): errno => {
				try {
					return connection.call(fd_read, [fd, iovs_ptr, iovs_len, bytesRead_ptr], memory(), fd_read.transfers(memoryView(), iovs_ptr, iovs_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_readdir: (fd: fd, buf_ptr: ptr<dirent>, buf_len: size, cookie: dircookie, buf_used_ptr: ptr<u32>): errno => {
				try {
					return connection.call(fd_readdir, [fd, buf_ptr, buf_len, cookie, buf_used_ptr], memory(), fd_readdir.transfers(memoryView(), buf_ptr, buf_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_seek: (fd: fd, offset: filedelta, whence: whence, new_offset_ptr: ptr<u64>): errno => {
				try {
					return connection.call(fd_seek, [fd, offset, whence, new_offset_ptr], memory(), fd_seek.transfers());
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			fd_write: (fd: fd, ciovs_ptr: ptr<ciovec>, ciovs_len: u32, bytesWritten_ptr: ptr<u32>): errno => {
				try {
					return connection.call(fd_write, [fd, ciovs_ptr, ciovs_len, bytesWritten_ptr], memory(), fd_write.transfers(memoryView(), ciovs_ptr, ciovs_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			path_create_directory: (fd: fd, path_ptr: ptr<u8[]>, path_len: size): errno => {
				try {
					return connection.call(path_create_directory, [fd, path_ptr, path_len], memory(), path_create_directory.transfers(memoryView(), path_ptr, path_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			path_filestat_get: (fd: fd, flags: lookupflags, path_ptr: ptr<u8[]>, path_len: size, filestat_ptr: ptr): errno => {
				try {
					return connection.call(path_filestat_get, [fd, flags, path_ptr, path_len, filestat_ptr], memory(), path_filestat_get.transfers(memoryView(), path_ptr, path_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			path_open: (fd: fd, dirflags: lookupflags, path_ptr: ptr<u8[]>, path_len: size, oflags: oflags, fs_rights_base: rights, fs_rights_inheriting: rights, fdflags: fdflags, fd_ptr: ptr<fd>): errno => {
				try {
					return connection.call(path_open, [fd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, fd_ptr], memory(), path_open.transfers(memoryView(), path_ptr, path_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			path_readlink: (fd: fd, path_ptr: ptr<u8[]>, path_len: size, buf_ptr: ptr, buf_len: size, result_size_ptr: ptr<u32>): errno => {
				try {
					return connection.call(path_readlink, [fd, path_ptr, path_len, buf_ptr, buf_len, result_size_ptr], memory(), path_readlink.transfers(memoryView(), path_ptr, path_len, buf_ptr, buf_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			path_rename: (old_fd: fd, old_path_ptr: ptr<u8[]>, old_path_len: size, new_fd: fd, new_path_ptr: ptr<u8[]>, new_path_len: size): errno => {
				try {
					return connection.call(path_rename, [old_fd, old_path_ptr, old_path_len, new_fd, new_path_ptr, new_path_len], memory(), path_rename.transfers(memoryView(), old_path_ptr, old_path_len, new_path_ptr, new_path_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			path_unlink_file: (fd: fd, path_ptr: ptr<u8[]>, path_len: size): errno => {
				try {
					return connection.call(path_unlink_file, [fd, path_ptr, path_len], memory(), path_unlink_file.transfers(memoryView(), path_ptr, path_len));
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
			poll_oneoff: (input: ptr<subscription>, output: ptr<event[]>, subscriptions: size, result_size_ptr: ptr<u32>): errno => {
				const view = memoryView();

				// First, scan our event list to see if we can handle this efficiently.
				let instant = false;
				let fastpath = true;
				{
					let subscription_offset: ptr = input;
					for (let i = 0; i < subscriptions; i++) {
						switch (view.getUint8(subscription_offset + Subscription.offset_u + Subscription_u.offset_type)) {
							case Eventtype.clock: {
								const clockOffset = subscription_offset + Subscription.offset_u + Subscription_u.offset_clock;
								const timeout = Subscription_clock.getTimeout(view, clockOffset);
								const flags = Subscription_clock.getFlags(view, clockOffset);
								if (timeout <= 0n && (flags & Subclockflags.subscription_clock_abstime) === 0) {
									instant = true;
								} else {
									fastpath = false;
								}
								break;
							}
							case Eventtype.fd_read:
								const fd = Subscription_fd_readwrite.get_file_descriptor(view, subscription_offset + Subscription.offset_u + Subscription_u.offset_fd_read);
								if (fd !== 0) fastpath = false;
								break;
							default:
								fastpath = false;
								break;
						}

						subscription_offset += Subscription.size;
					}
				}

				// If we can't use the fastpath, abort.
				if (!fastpath) {
					console.warn("Using slow poll_oneoff")
					try {
						return connection.call(poll_oneoff, [input, output, subscriptions, result_size_ptr], memory(), poll_oneoff.transfers(memoryView(), input, output, subscriptions));
					} catch (error) {
						return handleError(error, Errno.inval);
					}
				}

				let events: u32 = 0;
				let subscription_offset: ptr = input;
				let event_offset: ptr = output;
				for (let i = 0; i < subscriptions; i++) {
					switch (view.getUint8(subscription_offset + Subscription.offset_u + Subscription_u.offset_type)) {
						case Eventtype.clock: {
							// We're on the fast path, so can know this is an instant clock.
							events++;
							Event.write(
								view, event_offset, Subscription.getUserdata(view, subscription_offset),
								Eventtype.clock, Errno.success, 0n, 0
							);
							event_offset += Event.size;
							break;
						}
						case Eventtype.fd_read: {
							// We're on the fast path, so read from stdin.
							if (!instant) Atomics.wait($sharedMemory!!, 0, 0n);
							const readable = Atomics.load($sharedMemory!!, 0);
							if (readable <= 0n) continue;

							events++;
							Event.write(
								view, event_offset, Subscription.getUserdata(view, subscription_offset),
								Eventtype.fd_read, Errno.success, readable, 0
							);
							event_offset += Event.size;
							break;
						}
						default:
							throw new Error("Impossible case on the fastpath")
					}

					subscription_offset += Subscription.size;
				}

				view.setUint32(result_size_ptr, events, true);
				return Errno.success;
			},
			proc_exit: (rval: exitcode) => {
				try {
					return connection.call(proc_exit, [rval], memory());
				} catch (error) {
					return handleError(error, Errno.inval);
				}
			},
		};

		return wasi;
	}
}

export interface Tracer {
	tracer: WasiHost;
	printSummary(): void;
}

export namespace TraceWasiHost {
	export function create(connection: HostConnection, host: WasiHost): Tracer {
		const timePerFunction: Map<string, { count: number; time: number }> = new Map();
		const traceMessage = TraceMessage.create();

		function printSummary(): void {
			const summary: string[] = [];
			for (const [name, { count, time }] of timePerFunction.entries()) {
				summary.push(`${name} was called ${count} times and took ${time}ms in total. Average time: ${time / count}ms.`);
			}
			connection.postMessage({ method: 'traceSummary', summary: summary });
		}

		const proxy = new Proxy<WasiHost>(host, {
			get: (target: WasiHost, property: string | symbol, receiver: any) => {
				const value = Reflect.get(target, property, receiver);
				const propertyName = property.toString();
				if (typeof value === 'function') {
					return (...args: any[]) => {
						if (propertyName === 'proc_exit') {
							printSummary();
						}
						const start = Date.now();
						const result = value.apply(target, args);
						const timeTaken = Date.now() - start;

						const traceFunction = traceMessage[propertyName];
						const message = traceFunction !== undefined
							? traceFunction(host.memory(), result, ...(args as (number & bigint)[]))
							: `Missing trace function for ${propertyName}. Execution took ${timeTaken}ms.`;
						connection.postMessage({ method: 'trace', message, timeTaken });

						if (propertyName !== 'fd_read' || (args[0] !== 0 && args[0] !== 1 && args[0] !== 2)) {
							let perFunction = timePerFunction.get(property.toString());
							if (perFunction === undefined) {
								perFunction = { count: 0, time: 0 };
								timePerFunction.set(property.toString(), perFunction);
							}
							perFunction.count++;
							perFunction.time += timeTaken;
						}
						return result;
					};
				} else {
					return value;
				}
			}
		});
		return {
			tracer: proxy,
			printSummary: printSummary
		};
	}
}
