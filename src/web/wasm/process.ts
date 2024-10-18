/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LogOutputChannel, Uri, WorkspaceFolder, window, workspace } from 'vscode';

import type {
	ExtensionLocationDescriptor, MountPointDescriptor, ProcessOptions, Readable,
	VSCodeFileSystemDescriptor, WorkspaceFolderDescriptor, Writable,
} from './api';
import type { FileSystemDeviceDriver } from './deviceDriver';
import { FileDescriptors } from './fileDescriptor';
import WasiKernel, { DeviceDrivers } from './kernel';
import * as path from './path';
import * as pdd from './pipeDriver';
import * as vrfs from './rootFileSystemDriver';
import { DeviceWasiService, EnvironmentOptions, EnvironmentWasiService, ProcessWasiService, WasiService } from './service';
import { ReadableStream, WritableStream } from './streams';
import { Errno, exitcode } from './wasi';

namespace MapDirDescriptor {
	export function getDescriptors(descriptors: MountPointDescriptor[] | undefined) : { workspaceFolders: WorkspaceFolderDescriptor | undefined; extensions: ExtensionLocationDescriptor[]; vscodeFileSystems: VSCodeFileSystemDescriptor[]} {
		let workspaceFolders: WorkspaceFolderDescriptor | undefined;
		const extensions: ExtensionLocationDescriptor[] = [];
		const vscodeFileSystems: VSCodeFileSystemDescriptor[] = [];
		if (descriptors === undefined) {
			return { workspaceFolders, extensions, vscodeFileSystems };
		}
		for (const descriptor of descriptors) {
			if (descriptor.kind === 'workspaceFolder') {
				workspaceFolders = descriptor;
			} else if (descriptor.kind === 'extensionLocation') {
				extensions.push(descriptor);
			}
		}
		return { workspaceFolders, extensions, vscodeFileSystems };
	}
}

let $channel: LogOutputChannel | undefined;
function channel(): LogOutputChannel {
	if ($channel === undefined) {
		$channel = window.createOutputChannel('Wasm Core', { log: true });
	}
	return $channel;
}

export abstract class WasiProcess {

	private _state: 'created' | 'initialized' | 'running' | 'exiting' | 'exited';
	private readonly programName: string;
	protected readonly options: Omit<ProcessOptions, 'trace'> & { trace: LogOutputChannel | undefined };
	private localDeviceDrivers: DeviceDrivers;
	private resolveCallback: ((value: number) => void) | undefined;
	private readonly fileDescriptors: FileDescriptors;
	private environmentService!: EnvironmentWasiService;
	private processService!: ProcessWasiService;
	private readonly preOpenDirectories: Map<string, FileSystemDeviceDriver>;
	private virtualRootFileSystem: vrfs.RootFileSystemDeviceDriver | undefined;

	protected readonly sharedMemory: SharedArrayBuffer = new SharedArrayBuffer(8);
	private _stdin: WritableStream | undefined;
	private _stdout: ReadableStream | undefined;
	private _stderr: ReadableStream | undefined;

	constructor(programName: string, options: ProcessOptions = {}) {
		this.programName = programName;
		let opt = Object.assign({}, options);
		delete opt.trace;
		if (options.trace === true) {
			this.options = Object.assign({}, opt, { trace: channel() });
		} else {
			this.options = Object.assign({}, opt, { trace: undefined });
		}
		this.localDeviceDrivers = WasiKernel.createLocalDeviceDrivers();
		this.fileDescriptors = new FileDescriptors();
		this.preOpenDirectories = new Map();
		this._state = 'created';
		this._stdin = undefined;
		this._stdout = undefined;
		this._stderr = undefined;
	}

	public get stdin(): Writable | undefined {
		return this._stdin;
	}

	public get stdout(): Readable | undefined {
		return this._stdout;
	}

	public get stderr(): Readable | undefined {
		return this._stderr;
	}

	protected get state(): typeof this._state {
		return this._state;
	}

	public async initialize(): Promise<void> {
		if (this._state !== 'created') {
			throw new Error('WasiProcess already initialized or running');
		}

		if (this.options.mountPoints) {
			const { workspaceFolders, extensions, vscodeFileSystems } = MapDirDescriptor.getDescriptors(this.options.mountPoints);
			if (workspaceFolders !== undefined) {
				const folders = workspace.workspaceFolders;
				if (folders !== undefined) {
					if (folders.length === 1) {
						await this.mapWorkspaceFolder(folders[0], true);
					} else {
						for (const folder of folders) {
							await this.mapWorkspaceFolder(folder, false);
						}
					}
				}
			}
			if (extensions.length > 0) {
				for (const descriptor of extensions) {
					const extensionFS = await WasiKernel.getOrCreateFileSystemByDescriptor(this.localDeviceDrivers, descriptor);
					this.preOpenDirectories.set(descriptor.mountPoint, extensionFS);
				}
			}
			if (vscodeFileSystems.length > 0) {
				for (const descriptor of vscodeFileSystems) {
					const fs = await WasiKernel.getOrCreateFileSystemByDescriptor(this.localDeviceDrivers, descriptor);
					this.preOpenDirectories.set(descriptor.mountPoint, fs);
				}
			}

			let needsRootFs = false;
			for (const mountPoint of this.preOpenDirectories.keys()) {
				if (mountPoint === '/') {
					if (this.preOpenDirectories.size > 1) {
						throw new Error(`Cannot mount root directory when other directories are mounted as well.`);
					}
				} else {
					needsRootFs = true;
				}
			}
			if (needsRootFs) {
				const mountPoints: Map<string, FileSystemDeviceDriver> = new Map(Array.from(this.preOpenDirectories.entries()));
				this.virtualRootFileSystem = vrfs.create(WasiKernel.nextDeviceId(), this.fileDescriptors, mountPoints);
				this.preOpenDirectories.set('/', this.virtualRootFileSystem);
				this.localDeviceDrivers.add(this.virtualRootFileSystem);
			}
		}

		const args: undefined | string[] = this.options.args !== undefined ? [] : undefined;
		if (this.options.args !== undefined && args !== undefined) {
			const uriToMountPoint: [string, string][] = [];
			for (const [mountPoint, driver] of this.preOpenDirectories) {
				let vsc_uri = driver.uri.toString(true);
				if (!vsc_uri.endsWith("/")) {
					vsc_uri += "/";
				}
				uriToMountPoint.push([vsc_uri, mountPoint]);
			}
			for (const arg of this.options.args) {
				if (typeof arg === 'string') {
					args.push(arg);
				} else if (arg instanceof Uri) {
					const arg_str = arg.toString(true);
					let mapped: boolean = false;
					for (const [uri, mountPoint] of uriToMountPoint) {
						if (arg_str.startsWith(uri)) {
							args.push(path.join(mountPoint, arg_str.substring(uri.length)));
							mapped = true;
							break;
						}
					}
					if (!mapped) {
						throw new Error(`Could not map argument ${arg_str} to a mount point.`);
					}
				} else {
					throw new Error('Invalid argument type');
				}
			}
		}

		// Setup stdio file descriptors
		this.handlePipes();

		const noArgsOptions = Object.assign({}, this.options);
		delete noArgsOptions.args;
		const options: EnvironmentOptions = Object.assign({}, noArgsOptions, { args });

		this.environmentService = EnvironmentWasiService.create(
			this.fileDescriptors, this.programName,
			this.preOpenDirectories.entries(), options
		);
		this.processService = {
			proc_exit: async (_memory, exitCode: exitcode) => {
				this._state = 'exiting';
				await this.procExit();
				this.resolveRunPromise(exitCode);
				return Promise.resolve(Errno.success);
			},
		};
		this._state = 'initialized';
	}

	public async run(): Promise<number> {
		if (this._state !== 'initialized') {
			throw new Error('WasiProcess is not initialized');
		}
		return new Promise<number>(async (resolve, reject) => {
			this.resolveCallback = resolve;
			const wasiService: WasiService = {
				...this.environmentService,
				...DeviceWasiService.create(this.localDeviceDrivers, this.fileDescriptors, this.virtualRootFileSystem),
				...this.processService
			};
			this.startMain(wasiService).catch(reject);
			this._state = 'running';
		}).then((exitCode) => {
			this._state = 'exited';
			return exitCode;
		});
	}

	protected abstract procExit(): Promise<void>;

	public abstract terminate(): Promise<number>;

	protected async destroyStreams(): Promise<void> {
		if (this._stdin !== undefined) {
			await this._stdin.destroy();
			this._stdin = undefined;
		}
		if (this._stdout !== undefined) {
			await this._stdout.destroy();
			this._stdout = undefined;
		}
		if (this._stderr !== undefined) {
			await this._stderr.destroy();
			this._stderr = undefined;
		}
	}

	protected async cleanupFileDescriptors(): Promise<void> {
		// Dispose any resources that are still allocated with a file descriptor
		for (const fd of this.fileDescriptors.values()) {
			if (fd.dispose !== undefined) {
				await fd.dispose();
			}
		}
	}

	protected resolveRunPromise(exitCode: exitcode): void {
		if (this.resolveCallback !== undefined) {
			this.resolveCallback(exitCode);
		}
	}

	protected abstract startMain(wasiService: WasiService): Promise<void>;

	private mapWorkspaceFolder(folder: WorkspaceFolder, single: boolean): Promise<void> {
		const mountPoint: string = single ? "/workspace" : `/workspaces/${folder.name}`;
		return this.mapDirEntry(folder.uri, mountPoint);
	}

	private async mapDirEntry(vscode_fs: Uri, mountPoint: string): Promise<void> {
		const fs = await WasiKernel.getOrCreateFileSystemByDescriptor(this.localDeviceDrivers, { kind: 'vscodeFileSystem', uri: vscode_fs, mountPoint});
		this.preOpenDirectories.set(mountPoint, fs);
	}

	private handlePipes(): void {
		this._stdin = new WritableStream(new BigInt64Array(this.sharedMemory));
		this._stdout = new ReadableStream();
		this._stderr = new ReadableStream();

		const pipeDevice = pdd.create(WasiKernel.nextDeviceId(), this._stdin, this._stdout, this._stderr);
		this.fileDescriptors.add(pipeDevice.createStdioFileDescriptor(0));
		this.fileDescriptors.add(pipeDevice.createStdioFileDescriptor(1));
		this.fileDescriptors.add(pipeDevice.createStdioFileDescriptor(2));
		this.localDeviceDrivers.add(pipeDevice);
	}
}
