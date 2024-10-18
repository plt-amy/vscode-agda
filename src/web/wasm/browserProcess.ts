/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { LogOutputChannel, Uri } from 'vscode';

import type { ProcessOptions } from './api';
import type { ServiceMessage, StartMainMessage, WorkerMessage } from './connection';
import { WasiProcess } from './process';
import { ServiceConnection, WasiService } from './service';

export class BrowserServiceConnection extends ServiceConnection {

	private readonly port: MessagePort | Worker;

	constructor(wasiService: WasiService, port: MessagePort | Worker, logChannel?: LogOutputChannel | undefined) {
		super(wasiService, logChannel);
		this.port = port;
		this.port.onmessage = ((event: MessageEvent<WorkerMessage>) => {
			this.handleMessage(event.data).catch((error) => console.error(error));
		});
	}

	public postMessage(message: ServiceMessage): void {
		try {
			this.port.postMessage(message);
		} catch (error) {
			console.error(error);
		}
	}
}

export class BrowserWasiProcess extends WasiProcess {

	private readonly baseUri: Uri;
	private readonly module: Promise<WebAssembly.Module>;

	private mainWorker: Worker | undefined;

	constructor(baseUri: Uri, programName: string, module: WebAssembly.Module | Promise<WebAssembly.Module>, options: ProcessOptions = {}) {
		super(programName, options);
		this.baseUri = baseUri;
		this.module = module instanceof WebAssembly.Module
			? Promise.resolve(module)
			: module;
	}

	protected async procExit(): Promise<void> {
		if (this.mainWorker !== undefined) {
			this.mainWorker.terminate();
		}
		await this.destroyStreams();
		await this.cleanupFileDescriptors();
	}

	public async terminate(): Promise<number> {
		const result = 0;
		await this.procExit();

		// when terminated, web workers silently exit, and there are no events
		// to hook on to know when they are done. To ensure that the run promise resolves,
		// we call it here so callers awaiting `process.run()` will get a result.
		this.resolveRunPromise(result);
		return result;
	}

	protected async startMain(wasiService: WasiService): Promise<void> {
		const filename = Uri.joinPath(this.baseUri, './out/web/mainWorker.js').toString();
		this.mainWorker = new Worker(filename);
		const connection = new BrowserServiceConnection(wasiService, this.mainWorker, this.options.trace);
		await connection.workerReady();
		const module = await this.module;
		if (this.doesImportMemory(module)) {
			throw new Error('Web assembly imports memory but no memory descriptor was provided.');
		}

		const message: StartMainMessage = {
			method: 'startMain', module: await this.module, trace: this.options.trace !== undefined,
			sharedMemory: this.sharedMemory,
		};
		connection.postMessage(message);
		connection.workerDone().then(async () => {
			await this.cleanupFileDescriptors();
			this.resolveRunPromise(0);

		}).catch((error) => { console.error(error); });
		return Promise.resolve();
	}

	private doesImportMemory(module: WebAssembly.Module): boolean {
		const imports = WebAssembly.Module.imports(module);
		for (const item of imports) {
			if (item.kind === 'memory' && item.name === 'memory') {
				return true;
			}
		}
		return false;
	}
}
