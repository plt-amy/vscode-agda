/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
  workspace, ExtensionContext, languages,
  DocumentSemanticTokensProvider, CancellationToken,
  SemanticTokens, TextDocument, Event, Uri, window, EventEmitter, WebviewViewProvider, WebviewView, WebviewViewResolveContext
} from 'vscode';
import { SemanticTokensFeature } from 'vscode-languageclient/lib/common/semanticTokens';

import {
  LanguageClient,
  LanguageClientOptions,
  Executable,
  TransportKind,
  SemanticTokensRefreshRequest,
  SemanticTokensRequest,
} from 'vscode-languageclient/node';

import * as rpc from '../api/rpc';

let client: LanguageClient;

class LanguageClientConnection implements rpc.Connection {
  constructor(private readonly client: LanguageClient) { }

  async postRequest<P extends {}, R>(query: rpc.Query<P, R>, params: P & { uri: string }): Promise<R> {
    return await this.client.sendRequest('agda/query', Object.assign({}, params, {
      kind: query.kind,
    }));
  }
}

class AgdaTokenProvider implements DocumentSemanticTokensProvider {
  private readonly emitter: EventEmitter<void> = new EventEmitter();
  readonly onDidChangeSemanticTokens: Event<void> = this.emitter.event;

  constructor(private readonly client: LanguageClient) {
    client.onRequest(SemanticTokensRefreshRequest.type, async () => {
      this.emitter.fire();
    });
  }

  async provideDocumentSemanticTokens(document: TextDocument, _token: CancellationToken): Promise<SemanticTokens> {
    console.log(`Asking for tokens for ${document.uri.path}`);
    const tokens = await this.client.sendRequest(SemanticTokensRequest.type, {
      textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document)
    });

    console.log("Got tokens:", tokens);
    const toks = await client.protocol2CodeConverter.asSemanticTokens(tokens);
    return toks!;
  }

  async provideDocumentSemanticTokensEdits(document: TextDocument, _previous: string, token: CancellationToken): Promise<SemanticTokens> {
    return this.provideDocumentSemanticTokens(document, token);
  }
}

export function activate(context: ExtensionContext) {
  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const command = workspace.getConfiguration("agda").get("agdaExecutable", "agda");
  const serverOptions: Executable = {
    command,
    args: ['--lsp', '-vlsp.query:30', '-vimport.iface.create:30'],
    transport: TransportKind.stdio,
  };

  const agdaSelector = { scheme: 'file', language: 'agda' };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for plain text documents
    documentSelector: [agdaSelector],
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

  SemanticTokensFeature.prototype.register = function () { };
  client.onNotification('agda/highlightingInit', ({ legend }) => {
    const decoded = client.protocol2CodeConverter.asSemanticTokensLegend(legend);
    context.subscriptions.push(
      languages.registerDocumentSemanticTokensProvider(agdaSelector, new AgdaTokenProvider(client), decoded)
    );
  });

  const infoview = new AgdaInfoviewProvider(context.extensionUri, client);
  const pro = window.registerWebviewViewProvider(AgdaInfoviewProvider.viewType, infoview);
  console.log(pro);

  const agda = new LanguageClientConnection(client);

  window.onDidChangeTextEditorSelection(async (e) => {
    if (e.textEditor.document.uri.scheme !== 'file') return;

    if (e.selections.length === 1) {
      const ip = await agda.postRequest(rpc.Query.GoalAt, {
        position: client.code2ProtocolConverter.asPosition(e.textEditor.selections[0].start),
        uri: e.textEditor.document.uri.toString(),
      });
      console.log(ip)
      if (typeof ip !== 'number') {
        infoview.allGoals(e.textEditor.document.uri.toString())
      } else {
        infoview.goal(ip, e.textEditor.document.uri.toString());
      };
    }
  });
}

class AgdaInfoviewProvider implements WebviewViewProvider {
  public static readonly viewType = 'agda.infoView';
  private readonly extensionUri: Uri;
  private view?: WebviewView;

  constructor(extensionUri: Uri, private readonly client: LanguageClient) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(webviewView: WebviewView, context: WebviewViewResolveContext<unknown>, token: CancellationToken): void | Thenable<void> {
    console.log(webviewView, context, token);
    this.view = webviewView;
    webviewView.show();

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
    };

    webviewView.webview.html = `<html>
      <body>
        <div id="container" style="font-size: 20pt; font-family: var(--vscode-editor-font-family);"></div>
      </body>

      <script src="${webviewView.webview.asWebviewUri(Uri.joinPath(this.extensionUri, "out", "infoview", "index.js"))}"></script>
    </html>
    `;

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.kind === 'RPCRequest') {
        console.log('Forwarding request', msg)
        const resp = await this.client.sendRequest('agda/query', msg.params);

        webviewView.webview.postMessage({
          kind:   'RPCReply',
          serial: msg.serial,
          data:   resp
        });
      }
    }, undefined, []);
  }

  allGoals(uri: string) {
    if (!this.view) return;
    this.view.webview.postMessage({
      kind: 'Navigate',
      route: `/?uri=${uri}`
    })
  }

  goal(ip: number, uri: string) {
    if (!this.view) return;
    this.view.webview.postMessage({
      kind:  'Navigate',
      route: `/goal/${ip}?uri=${uri}`
    })
  }
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
