/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext, languages, SemanticTokensLegend,
Position, DocumentSemanticTokensProvider, CancellationToken,
ProviderResult, SemanticTokens, TextDocument, Event, SemanticTokensBuilder, Uri, Range, window, TextEditor, TextEditorDecorationType, DecorationRenderOptions, EventEmitter } from 'vscode';
import { SemanticTokensFeature } from 'vscode-languageclient/lib/common/semanticTokens';

import {
  LanguageClient,
  LanguageClientOptions,
  Executable,
  TransportKind,
  ProtocolNotificationType0,
  SemanticTokensRefreshRequest,
  SemanticTokensRequest,
  Trace
} from 'vscode-languageclient/node';

let client: LanguageClient;

interface TokenData {
  readonly tokenStart: number;
  readonly tokenEnd:   number;
  readonly tokenType:  string;
}

class AgdaTokenProvider implements DocumentSemanticTokensProvider {
  private readonly emitter: EventEmitter<void> = new EventEmitter();
  readonly onDidChangeSemanticTokens: Event<void> = this.emitter.event;

  constructor (private readonly client: LanguageClient) {
    client.onRequest(SemanticTokensRefreshRequest.type, async () => {
      this.emitter.fire();
    });
  }

  async provideDocumentSemanticTokens(document: TextDocument, token: CancellationToken): Promise<SemanticTokens> {
    const tokens = await client.sendRequest(SemanticTokensRequest.type, {
      textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document)
    });
    console.log("Got tokens:", tokens);
    const toks = await client.protocol2CodeConverter.asSemanticTokens(tokens);
    return toks;
  }

  async provideDocumentSemanticTokensEdits(document: TextDocument, previous: string, token: CancellationToken): Promise<SemanticTokens> {
    return this.provideDocumentSemanticTokens(document, token);
  }
}

export function activate(context: ExtensionContext) {
  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const command = workspace.getConfiguration("agda").get("agdaExecutable", "agda");
  const serverOptions: Executable = {
    command,
    args: ['--lsp'],
    transport: TransportKind.stdio,
  };

  const agda = { scheme: 'file', language: 'agda' };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for plain text documents
    documentSelector: [agda],
    synchronize: {
      configurationSection: 'agda',
    }
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    'agda',
    'Agda Language Server',
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start();

  SemanticTokensFeature.prototype.register = function() {};
  client.onNotification('agda/highlightingInit', ({ legend }) => {
    const decoded = client.protocol2CodeConverter.asSemanticTokensLegend(legend);
    context.subscriptions.push(
      languages.registerDocumentSemanticTokensProvider(agda, new AgdaTokenProvider(client), decoded)
    );
  });
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
