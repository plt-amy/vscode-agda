import { ExtensionContext, workspace } from "vscode";
import { Executable, LanguageClient, TransportKind } from "vscode-languageclient/node";
import { activate as activateImpl } from "../common/extension";

export function activate(context: ExtensionContext) {
  return activateImpl(context, clientOptions => {
    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const command = workspace.getConfiguration("agda").get("executable.path", "agda");
    const opts = workspace.getConfiguration("agda").get<string[]>("executable.options", []);

    const args: string[] = ["--lsp", ...opts];

    const serverOptions: Executable = {
      command, args,
      transport: TransportKind.stdio,
    };

    // Create the language client and start the client.
    return new LanguageClient("agda", "Agda Language Server", serverOptions, clientOptions);
  });
}

export { deactivate } from "../common/extension";
