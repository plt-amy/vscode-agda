/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

import { ProcessOptions } from './api';
import { byte, bytes, cstring, ptr, size, u32, u64 } from './baseTypes';
import { Offsets, TraceMessage, TraceSummaryMessage, WasiCallMessage, WorkerDoneMessage, WorkerMessage, WorkerReadyMessage } from './connection';
import { BigInts, code2Wasi } from './converter';
import { DeviceDriver, FileSystemDeviceDriver, ReaddirEntry } from './deviceDriver';
import { FileDescriptor, FileDescriptors } from './fileDescriptor';
import { DeviceDrivers } from './kernel';
import { isAbsolute, normalize as normalizePath } from "./path";
import { RootFileSystemDeviceDriver } from './rootFileSystemDriver';
import { CompletablePromise, createCompletablePromise, decodeText, encodeText } from './support';
import {
	args_get, args_sizes_get, Ciovec, ciovec, dircookie, Dirent, dirent, environ_get, environ_sizes_get, errno,
	Errno, Event, event, Eventtype, fd, fd_close, fd_fdstat_get, fd_fdstat_set_flags, fd_filestat_get,
	fd_filestat_set_size, fd_prestat_dir_name, fd_prestat_get, fd_read, fd_readdir, fd_seek, fd_write,
	fdflags, Fdstat, fdstat, filedelta, filesize, Filestat, filestat, Iovec, iovec, Literal, lookupflags, oflags,
	path_create_directory, path_filestat_get, path_open, path_readlink, path_rename, path_unlink_file,
	poll_oneoff, Preopentype, Prestat, prestat, proc_exit, rights, Rights, Subclockflags, Subscription, subscription,
	tid, WasiError, Whence, whence,
} from './wasi';
import { WasiFunction, WasiFunctions, WasiFunctionSignature } from './wasiMeta';

export abstract class ServiceConnection {

	private readonly wasiService: WasiService;
	private readonly logChannel: vscode.LogOutputChannel | undefined;

	private readonly _workerReady: CompletablePromise<void>;

	private readonly _workerDone: CompletablePromise<void>;

	constructor(wasiService: WasiService, logChannel?: vscode.LogOutputChannel | undefined) {
		this.wasiService = wasiService;
		this.logChannel = logChannel;
		this._workerReady = createCompletablePromise<void>();
		this._workerDone = createCompletablePromise<void>();
	}

	public workerReady(): Promise<void> {
		return this._workerReady.promise;
	}

	public workerDone(): Promise<void> {
		return this._workerDone.promise;
	}

	protected async handleMessage(message: WorkerMessage): Promise<void> {
		if (WasiCallMessage.is(message)) {
			try {
				await this.handleWasiCallMessage(message);
			} catch (error) {
				console.error(error);
			}
		} else if (WorkerReadyMessage.is(message)) {
			this._workerReady.resolve();
		} else if (WorkerDoneMessage.is(message)) {
			this._workerDone.resolve();
		} else if (this.logChannel !== undefined) {
			if (TraceMessage.is(message)) {
				const timeTaken = message.timeTaken;
				const final = `${message.message} (${timeTaken}ms)`;
				if (timeTaken > 10) {
					this.logChannel.error(final);
				} else if (timeTaken > 5) {
					this.logChannel.warn(final);
				} else {
					this.logChannel.info(final);
				}
			} else if (TraceSummaryMessage.is(message)) {
				if (message.summary.length === 0) {
					return;
				}
				this.logChannel.info(`Call summary:\n\t${message.summary.join('\n\t')}`);
			}
		}
	}

	private async handleWasiCallMessage(message: WasiCallMessage): Promise<void> {
		const [paramBuffer, wasmMemory] = message;
		const paramView = new DataView(paramBuffer);
		try {

			const method = paramView.getUint32(Offsets.method_index, true);
			const func: WasiFunction = WasiFunctions.functionAt(method);
			if (func === undefined) {
				throw new WasiError(Errno.inval);
			}
			const params = this.getParams(func.signature, paramBuffer);
			const result = await this.wasiService[func.name](wasmMemory, ...params);
			paramView.setUint16(Offsets.errno_index, result, true);
		} catch (err) {
			if (err instanceof WasiError) {
				paramView.setUint16(Offsets.errno_index, err.errno, true);
			} else {
				paramView.setUint16(Offsets.errno_index, Errno.inval, true);
			}
		}

		const sync = new Int32Array(paramBuffer, 0, 1);
		Atomics.store(sync, 0, 1);
		Atomics.notify(sync, 0);
	}

	private getParams(signature: WasiFunctionSignature, paramBuffer: SharedArrayBuffer): (number & bigint)[] {
		const paramView = new DataView(paramBuffer);
		const params: (number | bigint)[] = [];
		let offset = Offsets.header_size;
		for (let i = 0; i < signature.params.length; i++) {
			const param = signature.params[i];
			params.push(param.read(paramView, offset));
			offset += param.size;
		}
		return params as (number & bigint)[];
	}
}

export interface EnvironmentWasiService {
	args_sizes_get: args_sizes_get.ServiceSignature;
	args_get: args_get.ServiceSignature;
	environ_sizes_get: environ_sizes_get.ServiceSignature;
	environ_get: environ_get.ServiceSignature;
	fd_prestat_get: fd_prestat_get.ServiceSignature;
	fd_prestat_dir_name: fd_prestat_dir_name.ServiceSignature;
}

interface DeviceWasiService {
	fd_close: fd_close.ServiceSignature;
	fd_fdstat_get: fd_fdstat_get.ServiceSignature;
	fd_fdstat_set_flags: fd_fdstat_set_flags.ServiceSignature;
	fd_filestat_get: fd_filestat_get.ServiceSignature;
	fd_filestat_set_size: fd_filestat_set_size.ServiceSignature;
	fd_read: fd_read.ServiceSignature;
	fd_readdir: fd_readdir.ServiceSignature;
	fd_seek: fd_seek.ServiceSignature;
	fd_write: fd_write.ServiceSignature;
	path_create_directory: path_create_directory.ServiceSignature;
	path_filestat_get: path_filestat_get.ServiceSignature;
	path_open: path_open.ServiceSignature;
	path_readlink: path_readlink.ServiceSignature;
	path_rename: path_rename.ServiceSignature;
	path_unlink_file: path_unlink_file.ServiceSignature;
	poll_oneoff: poll_oneoff.ServiceSignature;
}

export interface ProcessWasiService {
	proc_exit: proc_exit.ServiceSignature;

}

export interface WasiService extends EnvironmentWasiService, DeviceWasiService, ProcessWasiService {
	[name: string]: (memory: ArrayBuffer, ...args: (number & bigint)[]) => Promise<errno | tid>;
}

export interface EnvironmentOptions extends Omit<ProcessOptions, 'args' | 'trace'> {
	args?: string[];
}

export namespace EnvironmentWasiService {
	export function create(fileDescriptors: FileDescriptors, programName: string, preStats: IterableIterator<[string, DeviceDriver]>, options: EnvironmentOptions): EnvironmentWasiService {

		const $preStatDirnames: Map<fd, string> = new Map();

		const result: EnvironmentWasiService = {
			args_sizes_get: (memory: ArrayBuffer, argvCount_ptr: ptr<u32>, argvBufSize_ptr: ptr<u32>): Promise<errno> => {
				let count = 0;
				let size = 0;
				function processValue(str: string): void {
					const value = `${str}\0`;
					size += encodeText(value).byteLength;
					count++;
				}
				processValue(programName);
				for (const arg of options.args ?? []) {
					processValue(arg);
				}
				const view = new DataView(memory);
				view.setUint32(argvCount_ptr, count, true);
				view.setUint32(argvBufSize_ptr, size, true);
				return Promise.resolve(Errno.success);
			},
			args_get: (memory: ArrayBuffer, argv_ptr: ptr<u32[]>, argvBuf_ptr: ptr<cstring>): Promise<errno> => {
				const memoryView = new DataView(memory);
				const memoryBytes = new Uint8Array(memory);
				let entryOffset = argv_ptr;
				let valueOffset = argvBuf_ptr;

				function processValue(str: string): void {
					const data = encodeText(`${str}\0`);
					memoryView.setUint32(entryOffset, valueOffset, true);
					entryOffset += 4;
					memoryBytes.set(data, valueOffset);
					valueOffset += data.byteLength;
				}
				processValue(programName);
				for (const arg of options.args ?? []) {
					processValue(arg);
				}
				return Promise.resolve(Errno.success);
			},
			environ_sizes_get: (memory: ArrayBuffer, environCount_ptr: ptr<u32>, environBufSize_ptr: ptr<u32>): Promise<errno> => {
				let count = 0;
				let size = 0;
				for (const entry of Object.entries(options.env ?? {})) {
					const value = `${entry[0]}=${entry[1]}\0`;
					size += encodeText(value).byteLength;
					count++;
				}
				const view = new DataView(memory);
				view.setUint32(environCount_ptr, count, true);
				view.setUint32(environBufSize_ptr, size, true);
				return Promise.resolve(Errno.success);
			},
			environ_get: (memory: ArrayBuffer, environ_ptr: ptr<u32>, environBuf_ptr: ptr<cstring>): Promise<errno> => {
				const view = new DataView(memory);
				const bytes = new Uint8Array(memory);
				let entryOffset = environ_ptr;
				let valueOffset = environBuf_ptr;
				for (const entry of Object.entries(options.env ?? {})) {
					const data = encodeText(`${entry[0]}=${entry[1]}\0`);
					view.setUint32(entryOffset, valueOffset, true);
					entryOffset += 4;
					bytes.set(data, valueOffset);
					valueOffset += data.byteLength;
				}
				return Promise.resolve(Errno.success);
			},
			fd_prestat_get: async (memory: ArrayBuffer, fd: fd, bufPtr: ptr<prestat>): Promise<errno> => {
				try {
					const next = preStats.next();
					if (next.done === true) {
						fileDescriptors.switchToRunning(fd);
						return Errno.badf;
					}
					const [mountPoint, driver] = next.value;
					const fileDescriptor = await driver.fd_create_prestat_fd(fd);
					fileDescriptors.add(fileDescriptor);
					fileDescriptors.setRoot(driver, fileDescriptor);
					$preStatDirnames.set(fileDescriptor.fd, mountPoint);
					const view = new DataView(memory);
					const prestat = Prestat.create(view, bufPtr);
					prestat.preopentype = Preopentype.dir;
					prestat.len = encodeText(mountPoint).byteLength;
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			fd_prestat_dir_name: (memory: ArrayBuffer, fd: fd, pathPtr: ptr<byte[]>, pathLen: size): Promise<errno> => {
				try {
					const fileDescriptor = fileDescriptors.get(fd);
					const dirname = $preStatDirnames.get(fileDescriptor.fd);
					if (dirname === undefined) {
						return Promise.resolve(Errno.badf);
					}
					const bytes = encodeText(dirname);
					if (bytes.byteLength !== pathLen) {
						Errno.badmsg;
					}
					const raw = new Uint8Array(memory, pathPtr);
					raw.set(bytes);
					return Promise.resolve(Errno.success);
				} catch (error) {
					return Promise.resolve(handleError(error));
				}
			}
		};

		function handleError(error: any, def: errno = Errno.badf): errno {
			if (error instanceof WasiError) {
				return error.errno;
			} else if (error instanceof vscode.FileSystemError) {
				return code2Wasi.asErrno(error.code);
			}
			return def;
		}

		return result;
	}
}

export namespace DeviceWasiService {
	export function create(deviceDrivers: DeviceDrivers, fileDescriptors: FileDescriptors, virtualRootFileSystem: RootFileSystemDeviceDriver | undefined): DeviceWasiService {

		const $directoryEntries: Map<fd, ReaddirEntry[]> = new Map();

		const result: DeviceWasiService = {
			fd_close: async (_memory: ArrayBuffer, fd: fd): Promise<errno> => {
				const fileDescriptor = getFileDescriptor(fd);
				try {

					await getDeviceDriver(fileDescriptor).fd_close(fileDescriptor);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				} finally {
					fileDescriptors.delete(fileDescriptor);
					if (fileDescriptor.dispose !== undefined) {
						await fileDescriptor.dispose();
					}
				}
			},
			fd_fdstat_get: async (memory: ArrayBuffer, fd: fd, fdstat_ptr: ptr<fdstat>): Promise<errno> => {
				try {
					const fileDescriptor = getFileDescriptor(fd);

					await getDeviceDriver(fileDescriptor).fd_fdstat_get(fileDescriptor, Fdstat.create(new DataView(memory), fdstat_ptr));
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			fd_fdstat_set_flags: async (_memory: ArrayBuffer, fd: fd, fdflags: fdflags): Promise<errno> => {
				try {
					const fileDescriptor = getFileDescriptor(fd);
					fileDescriptor.assertBaseRights(Rights.fd_fdstat_set_flags);

					await getDeviceDriver(fileDescriptor).fd_fdstat_set_flags(fileDescriptor, fdflags);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			fd_filestat_get: async (memory: ArrayBuffer, fd: fd, filestat_ptr: ptr<filestat>): Promise<errno> => {
				try {
					const fileDescriptor = getFileDescriptor(fd);
					fileDescriptor.assertBaseRights(Rights.fd_filestat_get);

					await getDeviceDriver(fileDescriptor).fd_filestat_get(fileDescriptor, Filestat.create(new DataView(memory), filestat_ptr));
					return Errno.success;
				} catch (error) {
					return handleError(error, Errno.perm);
				}
			},
			fd_filestat_set_size: async (_memory: ArrayBuffer, fd: fd, size: filesize): Promise<errno> => {
				try {
					const fileDescriptor = getFileDescriptor(fd);
					fileDescriptor.assertBaseRights(Rights.fd_filestat_set_size);

					await getDeviceDriver(fileDescriptor).fd_filestat_set_size(fileDescriptor, size);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			fd_read: async (memory: ArrayBuffer, fd: fd, iovs_ptr: ptr<iovec>, iovs_len: u32, bytesRead_ptr: ptr<u32>): Promise<errno> => {
				try {
					const fileDescriptor = getFileDescriptor(fd);
					fileDescriptor.assertBaseRights(Rights.fd_read);

					const view = new DataView(memory);
					const buffers = read_iovs(memory, iovs_ptr, iovs_len);
					const bytesRead = await getDeviceDriver(fileDescriptor).fd_read(fileDescriptor, buffers);
					view.setUint32(bytesRead_ptr, bytesRead, true);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			fd_readdir: async (memory: ArrayBuffer, fd: fd, buf_ptr: ptr<dirent>, buf_len: size, cookie: dircookie, buf_used_ptr: ptr<u32>): Promise<errno> => {
				try {
					const fileDescriptor = getFileDescriptor(fd);
					fileDescriptor.assertBaseRights(Rights.fd_readdir);
					fileDescriptor.assertIsDirectory();

					const driver = getDeviceDriver(fileDescriptor);
					const view = new DataView(memory);

					// We have a cookie > 0 but no directory entries. So return end  of list
					// todo@dirkb this is actually specified different. According to the spec if
					// the used buffer size is less than the provided buffer size then no
					// additional readdir call should happen. However at least under Rust we
					// receive another call.
					//
					// Also unclear whether we have to include '.' and '..'
					//
					// See also https://github.com/WebAssembly/wasi-filesystem/issues/3
					if (cookie !== 0n && !$directoryEntries.has(fileDescriptor.fd)) {
						view.setUint32(buf_used_ptr, 0, true);
						return Errno.success;
					}
					if (cookie === 0n) {
						$directoryEntries.set(fileDescriptor.fd, await driver.fd_readdir(fileDescriptor));
					}
					const entries: ReaddirEntry[] | undefined = $directoryEntries.get(fileDescriptor.fd);
					if (entries === undefined) {
						throw new WasiError(Errno.badmsg);
					}
					let i = Number(cookie);
					let ptr: ptr = buf_ptr;
					let spaceLeft = buf_len;
					for (; i < entries.length && spaceLeft >= Dirent.size; i++) {
						const entry = entries[i];
						const name = entry.d_name;
						const nameBytes = encodeText(name);
						const dirent: dirent = Dirent.create(view, ptr);
						dirent.d_next = BigInt(i + 1);
						dirent.d_ino = entry.d_ino;
						dirent.d_type = entry.d_type;
						dirent.d_namlen = nameBytes.byteLength;
						spaceLeft -= Dirent.size;
						const spaceForName = Math.min(spaceLeft, nameBytes.byteLength);
						(new Uint8Array(memory, ptr + Dirent.size, spaceForName)).set(nameBytes.subarray(0, spaceForName));
						ptr += Dirent.size + spaceForName;
						spaceLeft -= spaceForName;
					}
					if (i === entries.length) {
						view.setUint32(buf_used_ptr, ptr - buf_ptr, true);
						$directoryEntries.delete(fileDescriptor.fd);
					} else {
						view.setUint32(buf_used_ptr, buf_len, true);
					}
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			fd_seek: async (memory: ArrayBuffer, fd: fd, offset: filedelta, whence: whence, new_offset_ptr: ptr<u64>): Promise<errno> => {
				try {
					const fileDescriptor = getFileDescriptor(fd);
					if (whence === Whence.cur && offset === 0n && !fileDescriptor.containsBaseRights(Rights.fd_seek) && !fileDescriptor.containsBaseRights(Rights.fd_tell)) {
						throw new WasiError(Errno.perm);
					} else {
						fileDescriptor.assertBaseRights(Rights.fd_seek);
					}

					const view = new DataView(memory);
					const newOffset = await getDeviceDriver(fileDescriptor).fd_seek(fileDescriptor, offset, whence);
					view.setBigUint64(new_offset_ptr, BigInt(newOffset), true);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			fd_write: async (memory: ArrayBuffer, fd: fd, ciovs_ptr: ptr<ciovec>, ciovs_len: u32, bytesWritten_ptr: ptr<u32>): Promise<errno> => {
				try {
					const fileDescriptor = getFileDescriptor(fd);
					fileDescriptor.assertBaseRights(Rights.fd_write);

					const view = new DataView(memory);
					const buffers = read_ciovs(memory, ciovs_ptr, ciovs_len);
					const bytesWritten = await getDeviceDriver(fileDescriptor).fd_write(fileDescriptor, buffers);
					view.setUint32(bytesWritten_ptr, bytesWritten, true);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			path_create_directory: async (memory: ArrayBuffer, fd: fd, path_ptr: ptr<bytes>, path_len: size): Promise<errno> => {
				try {
								const parentFileDescriptor = getFileDescriptor(fd);
								parentFileDescriptor.assertBaseRights(Rights.path_create_directory);
								parentFileDescriptor.assertIsDirectory();

								const [deviceDriver, fileDescriptor, path] = getDeviceDriverWithPath(parentFileDescriptor, decodeText(new Uint8Array(memory, path_ptr, path_len)));
								if (fileDescriptor !== parentFileDescriptor) {
												fileDescriptor.assertBaseRights(Rights.path_create_directory);
												fileDescriptor.assertIsDirectory();
								}
								await deviceDriver.path_create_directory(fileDescriptor, path);
								return Errno.success;
				} catch (error) {
								return handleError(error);
				}
			},
			path_filestat_get: async (memory: ArrayBuffer, fd: fd, flags: lookupflags, path_ptr: ptr<bytes>, path_len: size, filestat_ptr: ptr): Promise<errno> => {
				try {
					const parentFileDescriptor = getFileDescriptor(fd);
					parentFileDescriptor.assertBaseRights(Rights.path_filestat_get);
					parentFileDescriptor.assertIsDirectory();

					const [deviceDriver, fileDescriptor, path] = getDeviceDriverWithPath(parentFileDescriptor, decodeText(new Uint8Array(memory, path_ptr, path_len)));
					if (fileDescriptor !== parentFileDescriptor) {
						fileDescriptor.assertBaseRights(Rights.path_filestat_get);
						fileDescriptor.assertIsDirectory();
					}
					await deviceDriver.path_filestat_get(fileDescriptor, flags, path, Filestat.create(new DataView(memory), filestat_ptr));
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			path_open: async (memory: ArrayBuffer, fd: fd, dirflags: lookupflags, path_ptr: ptr<bytes>, path_len: size, oflags: oflags, fs_rights_base: rights, fs_rights_inheriting: rights, fdflags: fdflags, fd_ptr: ptr<fd>): Promise<errno> => {
				try {
					const parentFileDescriptor = getFileDescriptor(fd);
					parentFileDescriptor.assertBaseRights(Rights.path_open);
					parentFileDescriptor.assertFdflags(fdflags);
					parentFileDescriptor.assertOflags(oflags);

					const [deviceDriver, fileDescriptor, path] = getDeviceDriverWithPath(parentFileDescriptor, decodeText(new Uint8Array(memory, path_ptr, path_len)));
					if (fileDescriptor !== parentFileDescriptor) {
						fileDescriptor.assertBaseRights(Rights.path_open);
						fileDescriptor.assertFdflags(fdflags);
						fileDescriptor.assertOflags(oflags);
					}
					const result = await deviceDriver.path_open(fileDescriptor, dirflags, path, oflags, fs_rights_base, fs_rights_inheriting, fdflags, fileDescriptors);
					fileDescriptors.add(result);
					const view = new DataView(memory);
					view.setUint32(fd_ptr, result.fd, true);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			path_readlink: async (memory: ArrayBuffer, fd: fd, path_ptr: ptr<bytes>, path_len: size, buf_ptr: ptr, buf_len: size, result_size_ptr: ptr<u32>): Promise<errno> => {
				try {
					const parentFileDescriptor = getFileDescriptor(fd);
					parentFileDescriptor.assertBaseRights(Rights.path_readlink);
					parentFileDescriptor.assertIsDirectory();

					const [deviceDriver, fileDescriptor, path] = getDeviceDriverWithPath(parentFileDescriptor, decodeText(new Uint8Array(memory, path_ptr, path_len)));
					if (fileDescriptor !== parentFileDescriptor) {
						fileDescriptor.assertBaseRights(Rights.path_readlink);
						fileDescriptor.assertIsDirectory();
					}
					const target = encodeText(await deviceDriver.path_readlink(fileDescriptor, path));
					if (target.byteLength > buf_len) {
						return Errno.inval;
					}
					new Uint8Array(memory, buf_ptr, buf_len).set(target);
					new DataView(memory).setUint32(result_size_ptr, target.byteLength, true);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			path_rename: async (memory: ArrayBuffer, old_fd: fd, old_path_ptr: ptr<bytes>, old_path_len: size, new_fd: fd, new_path_ptr: ptr<bytes>, new_path_len: size): Promise<errno> => {
				try {
					const oldParentFileDescriptor = getFileDescriptor(old_fd);
					oldParentFileDescriptor.assertBaseRights(Rights.path_rename_source);
					oldParentFileDescriptor.assertIsDirectory();

					const newParentFileDescriptor = getFileDescriptor(new_fd);
					newParentFileDescriptor.assertBaseRights(Rights.path_rename_target);
					newParentFileDescriptor.assertIsDirectory();

					const [oldDeviceDriver, oldFileDescriptor, oldPath] = getDeviceDriverWithPath(oldParentFileDescriptor, decodeText(new Uint8Array(memory, old_path_ptr, old_path_len)));
					const [newDeviceDriver, newFileDescriptor, newPath] = getDeviceDriverWithPath(newParentFileDescriptor, decodeText(new Uint8Array(memory, new_path_ptr, new_path_len)));
					if (oldDeviceDriver !== newDeviceDriver) {
						return Errno.nosys;
					}
					if (oldFileDescriptor !== oldParentFileDescriptor) {
						oldFileDescriptor.assertBaseRights(Rights.path_rename_source);
						oldFileDescriptor.assertIsDirectory();
					}
					if (newFileDescriptor !== newParentFileDescriptor) {
						newFileDescriptor.assertBaseRights(Rights.path_rename_target);
						newFileDescriptor.assertIsDirectory();
					}
					await oldDeviceDriver.path_rename(oldFileDescriptor, oldPath, newFileDescriptor, newPath);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			path_unlink_file: async (memory: ArrayBuffer, fd: fd, path_ptr: ptr<bytes>, path_len: size): Promise<errno> => {
				try {
					const parentFileDescriptor = getFileDescriptor(fd);
					parentFileDescriptor.assertBaseRights(Rights.path_unlink_file);
					parentFileDescriptor.assertIsDirectory();

					const [deviceDriver, fileDescriptor, path] = getDeviceDriverWithPath(parentFileDescriptor, decodeText(new Uint8Array(memory, path_ptr, path_len)));
					if (fileDescriptor !== parentFileDescriptor) {
						fileDescriptor.assertBaseRights(Rights.path_unlink_file);
						fileDescriptor.assertIsDirectory();
					}
					await deviceDriver.path_unlink_file(fileDescriptor, path);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
			poll_oneoff: async (memory: ArrayBuffer, input: ptr<subscription>, output: ptr<event[]>, subscriptions: size, result_size_ptr: ptr<u32>): Promise<errno> => {
				try {
					const view = new DataView(memory);
					let events = await handleSubscriptions(view, input, subscriptions);
					let event_offset = output;
					for (const item of events) {
						Event.write(
							view, event_offset, item.userdata,
							item.type, item.error, item.fd_readwrite.nbytes, item.fd_readwrite.flags
						);
						event_offset += Event.size;
					}
					view.setUint32(result_size_ptr, events.length, true);
					return Errno.success;
				} catch (error) {
					return handleError(error);
				}
			},
		};

		function handleSubscriptions(memory: DataView, input: ptr, subscriptions: size): Promise<event[]> {
			const promise = createCompletablePromise<event[]>();
			try {
				const events: event[] = [];
				handleSubscriptionsImpl(memory, input, subscriptions, event => {
					events.push(event);
					if (events.length === 1) promise.resolve(events);
				})
			} catch (e) {
				promise.reject(e);
			}
			return promise.promise;
		}

		function handleSubscriptionsImpl(memory: DataView, input: ptr, subscriptions: size, finish: (event: event) => void) {
			let subscription_offset: ptr = input;
			for (let i = 0; i < subscriptions; i++) {
				const subscription = Subscription.create(memory, subscription_offset);
				const u = subscription.u;
				switch (u.type) {
					case Eventtype.clock:
						handleClockSubscription(subscription, finish);
						break;
					case Eventtype.fd_read:
						handleReadSubscription(subscription).then(finish);
						break;
					case Eventtype.fd_write:
						finish(handleWriteSubscription(subscription));
						break;
				}
				subscription_offset += Subscription.size;
			}
		}

		function handleClockSubscription(subscription: subscription, finish: (event: event) => void) {
			const result: Literal<event> = {
				userdata: subscription.userdata,
				type: Eventtype.clock,
				error: Errno.success,
				fd_readwrite: {
					nbytes: 0n,
					flags: 0
				}
			};
			const clock = subscription.u.clock;
			// Timeout is in ns.
			let timeout: bigint;
			if ((clock.flags & Subclockflags.subscription_clock_abstime) !== 0) {
				console.error("Absolute time not supporte");
				result.error = Errno.inval;
				return finish(result);
			} else {
				timeout = clock.timeout;
			}

			setTimeout(() => finish(result), BigInts.asNumber(timeout / 1000000n));
		}

		async function handleReadSubscription(subscription: subscription): Promise<Literal<event>> {
			const fd = subscription.u.fd_read.file_descriptor;
			try {
				const fileDescriptor = getFileDescriptor(fd);
				if (!fileDescriptor.containsBaseRights(Rights.poll_fd_readwrite) && !fileDescriptor.containsBaseRights(Rights.fd_read)) {
					throw new WasiError(Errno.perm);
				}

				const available = await getDeviceDriver(fileDescriptor).fd_bytesAvailable(fileDescriptor);
				return {
					userdata: subscription.userdata,
					type: Eventtype.fd_read,
					error: Errno.success,
					fd_readwrite: {
						nbytes: available,
						flags: 0
					}
				};
			} catch (error) {
				return {
					userdata: subscription.userdata,
					type: Eventtype.fd_read,
					error: handleError(error),
					fd_readwrite: {
						nbytes: 0n,
						flags: 0
					}
				};
			}
		}

		function handleWriteSubscription(subscription: subscription): Literal<event> {
			const fd = subscription.u.fd_write.file_descriptor;
			try {
				const fileDescriptor = getFileDescriptor(fd);
				if (!fileDescriptor.containsBaseRights(Rights.poll_fd_readwrite) && !fileDescriptor.containsBaseRights(Rights.fd_write)) {
					throw new WasiError(Errno.perm);
				}
				return {
					userdata: subscription.userdata,
					type: Eventtype.fd_write,
					error: Errno.success,
					fd_readwrite: {
						nbytes: 0n,
						flags: 0
					}
				};
			} catch (error) {
				return {
					userdata: subscription.userdata,
					type: Eventtype.fd_write,
					error: handleError(error),
					fd_readwrite: {
						nbytes: 0n,
						flags: 0
					}
				};
			}
		}

		function handleError(error: any, def: errno = Errno.badf): errno {
			if (error instanceof WasiError) {
				return error.errno;
			} else if (error instanceof vscode.FileSystemError) {
				return code2Wasi.asErrno(error.code);
			}
			return def;
		}

		// Used when writing data
		function read_ciovs(memory: ArrayBuffer, iovs: ptr, iovsLen: u32): Uint8Array[] {
			const view = new DataView(memory);

			const buffers: Uint8Array[] = [];
			let ptr: ptr = iovs;
			for (let i = 0; i < iovsLen; i++) {
				const vec = Ciovec.create(view, ptr);
				// We need to copy the underlying memory since if it is a shared buffer
				// the WASM executable could already change it before we finally read it.
				const copy = new Uint8Array(vec.buf_len);
				copy.set(new Uint8Array(memory, vec.buf, vec.buf_len));
				buffers.push(copy);
				ptr += Ciovec.size;
			}
			return buffers;
		}

		// Used when reading data
		function read_iovs(memory: ArrayBuffer, iovs: ptr, iovsLen: u32): Uint8Array[] {
			const view = new DataView(memory);

			const buffers: Uint8Array[] = [];
			let ptr: ptr = iovs;
			for (let i = 0; i < iovsLen; i++) {
				const vec = Iovec.create(view, ptr);
				// We need a view onto the memory since we write the result into it.
				buffers.push(new Uint8Array(memory, vec.buf, vec.buf_len));
				ptr += Iovec.size;
			}
			return buffers;
		}

		function getDeviceDriver(fileDescriptor: FileDescriptor): DeviceDriver {
			return deviceDrivers.get(fileDescriptor.deviceId);
		}

		function getDeviceDriverWithPath(fileDescriptor: FileDescriptor, path: string): [DeviceDriver, FileDescriptor, string] {
			const result = deviceDrivers.get(fileDescriptor.deviceId);
			if (!isAbsolute(path) && virtualRootFileSystem !== undefined && virtualRootFileSystem !== result && FileSystemDeviceDriver.is(result)) {
				path = normalizePath(path);
				if (path.startsWith('..')) {
					const virtualPath = virtualRootFileSystem.makeVirtualPath(result, path);
					if (virtualPath === undefined) {
						throw new WasiError(Errno.noent);
					}
					const rootDescriptor = fileDescriptors.getRoot(virtualRootFileSystem);
					if (rootDescriptor === undefined) {
						throw new WasiError(Errno.noent);
					}
					return [virtualRootFileSystem, rootDescriptor, virtualPath];
				}
			}
			return [result, fileDescriptor, path];
		}

		function getFileDescriptor(fd: fd): FileDescriptor {
			const result = fileDescriptors.get(fd);
			if (result === undefined) {
				throw new WasiError(Errno.badf);
			}
			return result;
		}

		return result;
	}
}

export const NoSysWasiService: WasiService = {
	args_sizes_get: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	args_get: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	environ_sizes_get: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	environ_get: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_prestat_get: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_prestat_dir_name: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_close: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_fdstat_get: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_fdstat_set_flags: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_filestat_get: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_filestat_set_size: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_read: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_readdir: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_seek: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	fd_write: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	path_create_directory: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	path_filestat_get: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	path_open: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	path_readlink: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	path_rename: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	path_unlink_file: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	poll_oneoff: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
	proc_exit: (): Promise<number> => {
		throw new WasiError(Errno.nosys);
	},
};
