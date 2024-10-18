import { ExtensionContext, Uri, window, workspace } from "vscode";

import { LanguageClient, ServerOptions } from "vscode-languageclient/browser";

import { activate as activateImpl } from "../common/extension";
import { ProcessOptions } from "./wasm/api";
import { BrowserWasiProcess } from './wasm/browserProcess';
import { decodeText } from './wasm/support';
import { createUriConverters, startServer } from './wasmTransport';

const channel = window.createOutputChannel("Agda Language Server");

export async function activate(extension: ExtensionContext): Promise<void> {
  await activateImpl(extension, clientOptions => {
    const opts = workspace.getConfiguration("agda").get<string[]>("executable.options", []);

    const options: ProcessOptions = {
      args: ["--lsp", ...opts],
      mountPoints: [
        { kind: "workspaceFolder" },
        {
          kind: "extensionLocation",
          extension,
          path: "out/data",
          mountPoint: "/.agdaData",
        },
      ],
      env: {
        Agda_datadir: "/.agdaData",
        AGDA_DIR: "/.agdaData",
      },
      // trace: true,
    };

    const serverOptions: ServerOptions = async () => {
      const filename = Uri.joinPath(extension.extensionUri, "out", "agda.wasm");
      const bits = await workspace.fs.readFile(filename);
      const module = await WebAssembly.compile(bits);

      const process = new BrowserWasiProcess(extension.extensionUri, name, module, options);
      await process.initialize();

      process.stderr!.onData(data => channel.append(decodeText(data)));

      return startServer(process);
    };

    return new LanguageClient("agda", "Agda Language Server", serverOptions, {
      ...clientOptions,
      outputChannel: channel,
      uriConverters: createUriConverters(),
    });
  });
}

