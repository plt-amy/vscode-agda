/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext, languages, SemanticTokensLegend,
Position, DocumentSemanticTokensProvider, CancellationToken,
ProviderResult, SemanticTokens, TextDocument, Event, SemanticTokensBuilder, Uri, Range } from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  Executable,
  TransportKind,
  ProtocolNotificationType0
} from 'vscode-languageclient/node';

let client: LanguageClient;

const tokenTypes: string[] =
  [ 'namespace', 'class', 'enum', 'interface', 'struct',
  'typeParameter', 'type', 'parameter', 'variable', 'property',
  'enumMember', 'decorator', 'event', 'function', 'method', 'macro',
  'label', 'comment', 'string', 'keyword', 'number', 'regexp',
  'operator', 'Symbol', 'Pragma', 'InteractionPoint', 'Primitive', 'Postulate'
  ];

const tokenModifiers =
  [ 'declaration', 'definition', 'readonly',
  'static', 'deprecated', 'abstract', 'async', 'modification',
  'documentation', 'defaultLibrary' ];
const legend = new SemanticTokensLegend(tokenTypes, tokenModifiers);

type Token = {
  tokenStart: number,
  tokenEnd: number,
  tokenType: string
}

type PendingTokens = {
  document?: TextDocument,
  tokens?:   Token[],
  resolve?:  (tokens: SemanticTokens) => void,
}

class AgdaTokenProvider implements DocumentSemanticTokensProvider {
  private documents: Map<string, PendingTokens>;

  constructor(client: LanguageClient) {
    this.documents = new Map();

    console.log("Starting Agda client");
    client.onNotification('agda/pushTokens', (data) => {
      const has = this.documents.get(data.uri);
      if (!has) {
        this.documents.set(data.uri, {
          tokens: data.data
        });
      } else {
        has.tokens.push(...data.data);
      }
    });

    client.onNotification('agda/finishTokens', ({ uri }: { uri: string }) => {
      let has: PendingTokens | undefined;

      if ((has = this.documents.get(uri)) && has.document && has.resolve) {
        this.documents.delete(uri);
        console.log(`Finishing ${has.tokens.length} tokens for file ${uri}`);
        const builder = new SemanticTokensBuilder(legend);
        for (const tok of has.tokens) {
          const ps = has.document.positionAt(tok.tokenStart - 1),
            pe = has.document.positionAt(tok.tokenEnd - 1);

          if (pe.line != ps.line) continue;

          try {
            builder.push(new Range(ps, pe), tok.tokenType, []);
          } catch(e) {
            console.log(tok, e);
          }
        }
        has.resolve(builder.build());
      }
    });
  }

  provideDocumentSemanticTokens(document: TextDocument, token: CancellationToken): ProviderResult<SemanticTokens> {
    return new Promise((resolve) => {
      const key = document.uri.toString();
      const has = this.documents.get(key);
      if (!has) {
        this.documents.set(key, { document, resolve, tokens: [] });
      } else {
        has.document = document; has.resolve = resolve;
      }
    });
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

  context.subscriptions.push(languages.registerDocumentSemanticTokensProvider(agda, new AgdaTokenProvider(client), legend));
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
