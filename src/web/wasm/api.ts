/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Extension, ExtensionContext, Uri } from 'vscode';

/**
 * A writable stream.
 *
 * This interface is not intended to be implemented. Instances of this
 * interface are available via `Wasm.createWritable`.
 */
export interface Writable {

	/**
	 * Write some data to the stream.
	 * @param chunk The data to write.
	 */
	write(chunk: Uint8Array | string): Promise<void>;
}

/**
 * A readable stream.
 *
 * This interface is not intended to be implemented. Instances of this
 * interface are available via `Wasm.createReadable`.
 */
export interface Readable {
	/**
	 * Fires when data is available.
	 */
	onData: Event<Uint8Array>;
}

/**
 * A descriptor signaling that the workspace folder is mapped as `/workspace` or in case of a
 * multi-root workspace each folder is mapped as `/workspaces/folder-name`.
 */
export type WorkspaceFolderDescriptor = {
	kind: 'workspaceFolder';
};

/**
 * A descriptor signaling that the extension location is mapped under the given
 * mount point.
 */
export type ExtensionLocationDescriptor = {
	kind: 'extensionLocation';
	extension: ExtensionContext | Extension<any>;
	path: string;
	mountPoint: string;
};

/**
 * A descriptor signaling that a VS Code file system is mapped under the given
 * mount point.
 */
export type VSCodeFileSystemDescriptor = {
	kind: 'vscodeFileSystem';
	uri: Uri;
	mountPoint: string;
};

/**
 * The union of all mount point descriptors.
 */
export type MountPointDescriptor = WorkspaceFolderDescriptor | ExtensionLocationDescriptor | VSCodeFileSystemDescriptor;

/**
 * Options for a WASM process.
 */
export type ProcessOptions = {
	/**
	 * Command line arguments accessible in the WASM.
	 */
	args?: (string | Uri)[];

	/**
	 * The environment accessible in the WASM.
	 */
	env?: Record<string, string>;

	/**
	 * Whether the WASM/WASI API should be traced or not.
	 */
	trace?: boolean;

	/**
	 * How VS Code files systems are mapped into the WASM/WASI file system.
	 */
	mountPoints?: MountPointDescriptor[];
};

/**
 * A WASM process.
 */
export interface WasmProcess {

	/**
	 * The stdin of the WASM process or undefined if not available.
	 */
	readonly stdin: Writable | undefined;

	/**
	 * The stdout of the WASM process or undefined if not available.
	 */
	readonly stdout: Readable | undefined;

	/**
	 * The stderr of the WASM process or undefined if not available.
	 */
	readonly stderr: Readable | undefined;

	/**
	 * Runs the Wasm process.
	 */
	run(): Promise<number>;

	/**
	 * Terminate the Wasm process.
	 */
	 terminate(): Promise<number>;
}
