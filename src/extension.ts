/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext, languages, SemanticTokensLegend,
Position, DocumentSemanticTokensProvider, CancellationToken,
ProviderResult, SemanticTokens, TextDocument, Event, SemanticTokensBuilder, Uri, Range, window, TextEditor, TextEditorDecorationType, DecorationRenderOptions, EventEmitter, ViewColumn, WebviewViewProvider, WebviewView, WebviewViewResolveContext, StatusBarAlignment, ThemeColor } from 'vscode';
import { SemanticTokensFeature } from 'vscode-languageclient/lib/common/semanticTokens';

import {
  LanguageClient,
  LanguageClientOptions,
  Executable,
  TransportKind,
  ProtocolNotificationType0,
  SemanticTokensRefreshRequest,
  SemanticTokensRequest,
  Trace,
  Location,
  StaticFeature,
  ClientCapabilities,
  DocumentSelector,
  FeatureState,
  InitializeParams,
  ServerCapabilities
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
    console.log(`Asking for tokens for ${document.uri.path}`);
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

const decor = window.createTextEditorDecorationType({
  color: 'red'
});

export function activate(context: ExtensionContext) {
  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const command = workspace.getConfiguration("agda").get("agdaExecutable", "agda");
  const serverOptions: Executable = {
    command,
    args: ['--lsp', '-vlsp:30'],
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

  const infoview = new AgdaInfoviewProvider();
  const pro = window.registerWebviewViewProvider(AgdaInfoviewProvider.viewType, infoview);
  console.log(pro);

  window.onDidChangeTextEditorSelection(async (e) => {
    if (e.textEditor.document.uri.scheme !== 'file') return;

    if (e.selections.length === 1) {
      const loc: Location = {
        uri: e.textEditor.document.uri.toString(),
        range: {
          start: e.selections[0].start,
          end: e.selections[0].end
        }
      }
      const ip = await client.sendRequest('agda/interactionPoint', loc);
      infoview.setGoal(ip);
      console.log(ip);
    }
  });
}

class AgdaInfoviewProvider implements WebviewViewProvider {
  public static readonly viewType = 'agda.infoView';
  private view: WebviewView;

  resolveWebviewView(webviewView: WebviewView, context: WebviewViewResolveContext<unknown>, token: CancellationToken): void | Thenable<void> {
    console.log(webviewView, context, token);
    this.view = webviewView;
    webviewView.show();

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
    };

    webviewView.webview.html = `
    <html>
      <body>
        <div style="display: flex;">
          <span style="font-size:20pt; font-family: var(--vscode-editor-font-family)" id="goal"></span>
        </div>
      </body>

      <script>
        function createGoal(e) {
          if (typeof e === 'object' && e.tag && e.children) {
            const span = document.createElement('span');
            span.style = "color: var(--vscode-agda-" + e.tag + ");"
            span.replaceChildren(...e.children.map(createGoal))
            return span;
          }
          return document.createTextNode(e);
        }

        window.addEventListener('message', (e) => {
          const goal = document.getElementById("goal");
          console.log('message received', e);
          if (!e.data) { goal.replaceChildren(); return; }
          try {
            goal.replaceChildren(...e.data.data.map(createGoal));
          } catch(e) {
            console.log(e);
          }
        })
      </script>
    </html>
    `;
    webviewView.webview.onDidReceiveMessage(console.log);
    // webviewView.webview.postMessage()
  }

  setGoal(ip: any) {
    if (!this.view) return;
    this.view.webview.postMessage(ip);
  }
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
