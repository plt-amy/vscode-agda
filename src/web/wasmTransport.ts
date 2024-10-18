import {
  Disposable, Emitter, Event, Message, MessageTransports, RAL, ReadableStreamMessageReader, WriteableStreamMessageWriter
} from 'vscode-languageclient';
import { Uri, workspace } from 'vscode';

import { Readable, WasmProcess, Writable } from './wasm/api';

class ReadableStreamImpl implements RAL.ReadableStream {
  private readonly errorEmitter: Emitter<[Error, Message | undefined, number | undefined]>;
  private readonly closeEmitter: Emitter<void>;
  private readonly endEmitter: Emitter<void>;

  private readonly readable: Readable;

  constructor(readable: Readable) {
    this.errorEmitter = new Emitter<[Error, Message, number]>();
    this.closeEmitter = new Emitter<void>();
    this.endEmitter = new Emitter<void>();
    this.readable = readable;
  }

  public get onData(): Event<Uint8Array> {
    return this.readable.onData;
  }

  public get onError(): Event<[Error, Message | undefined, number | undefined]> {
    return this.errorEmitter.event;
  }

  public fireError(error: any, message?: Message, count?: number): void {
    this.errorEmitter.fire([error, message, count]);
  }

  public get onClose(): Event<void> {
    return this.closeEmitter.event;
  }

  public fireClose(): void {
    this.closeEmitter.fire(undefined);
  }

  public onEnd(listener: () => void): Disposable {
    return this.endEmitter.event(listener);
  }

  public fireEnd(): void {
    this.endEmitter.fire(undefined);
  }
}

type MessageBufferEncoding = RAL.MessageBufferEncoding;

class WritableStreamImpl implements RAL.WritableStream {

  private readonly errorEmitter: Emitter<[Error, Message | undefined, number | undefined]>;
  private readonly closeEmitter: Emitter<void>;
  private readonly endEmitter: Emitter<void>;

  private readonly writable: Writable;

  constructor(writable: Writable) {
    this.errorEmitter = new Emitter<[Error, Message, number]>();
    this.closeEmitter = new Emitter<void>();
    this.endEmitter = new Emitter<void>();
    this.writable = writable;
  }

  public get onError(): Event<[Error, Message | undefined, number | undefined]> {
    return this.errorEmitter.event;
  }

  public fireError(error: any, message?: Message, count?: number): void {
    this.errorEmitter.fire([error, message, count]);
  }

  public get onClose(): Event<void> {
    return this.closeEmitter.event;
  }

  public fireClose(): void {
    this.closeEmitter.fire(undefined);
  }

  public onEnd(listener: () => void): Disposable {
    return this.endEmitter.event(listener);
  }

  public fireEnd(): void {
    this.endEmitter.fire(undefined);
  }

  public write(data: string | Uint8Array, _encoding?: MessageBufferEncoding): Promise<void> {
    if (typeof data === 'string') {
      return this.writable.write(data);
    } else {
      return this.writable.write(data);
    }
  }

  public end(): void {
  }
}


export async function startServer(process: WasmProcess, readable: Readable | undefined = process.stdout, writable: Writable | undefined = process.stdin): Promise<MessageTransports> {
  if (readable === undefined || writable === undefined) {
    throw new Error('Process created without streams or no streams provided.');
  }

  const reader = new ReadableStreamImpl(readable);
  const writer = new WritableStreamImpl(writable);

  process.run().then(value => {
    if (value === 0) {
      reader.fireEnd();
    } else {
      reader.fireError([new Error(`Process exited with code: ${value}`), undefined, undefined]);
    }
  }, error => reader.fireError([error, undefined, undefined]));

  return { reader: new ReadableStreamMessageReader(reader), writer: new WriteableStreamMessageWriter(writer), detached: false };
}

// A copy of createUriConverters from @vscode/wasm-wasi-lsp.
// See https://github.com/microsoft/vscode-wasm/pull/208.
export const createUriConverters = (): { code2Protocol: (value: Uri) => string; protocol2Code: (value: string) => Uri } | undefined => {
  const folders = workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) return undefined;
  const mappings: [c: string, p: string][] = [];

  if (folders.length === 1) {
    mappings.push([folders[0].uri.toString(), "file:///workspace/"]);
  } else {
    for (const folder of folders) {
      mappings.push([folder.uri.toString(), `file:///workspace/${folder.name}/`]);
    }
  }
  return {
    code2Protocol: uri => {
      const str = uri.toString();
      for (const [c, p] of mappings) {
        if (str.startsWith(c)) return str.replace(c, p);
      }
      return str;
    },
    protocol2Code: value => {
      for (const [c, p] of mappings) {
        if (value.startsWith(p)) return Uri.parse(value.replace(p, c));
      }
      return Uri.parse(value);
    }
  };
};
