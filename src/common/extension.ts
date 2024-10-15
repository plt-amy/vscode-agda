import {
  CancellationToken, DocumentSemanticTokensProvider, Event, EventEmitter,
  ExtensionContext, SemanticTokens, TextDocument, languages, window
} from "vscode";
import * as vscode from "vscode";
import { SemanticTokensFeature } from "vscode-languageclient/lib/common/semanticTokens";

import {
  BaseLanguageClient as LanguageClient,
  LanguageClientOptions,
  SemanticTokensRefreshRequest,
  SemanticTokensRequest,
} from "vscode-languageclient";
import * as lsp from "vscode-languageclient";

import * as rpc from "../api/rpc";
import { AgdaInfoviewProvider } from "./AgdaInfoviewProvider";
import { AgdaGoals, AgdaHighlightingInit, AgdaInfoviewRefresh, AgdaQuery } from "../api/methods";
import { isAgdaDocument, agdaSelector } from './utils';

import registerServerStatus from './client/serverStatus';
import { InputCompletionProvider, InputHoverProvider } from './input/providers';
import { leader } from './input/data';

class LanguageClientConnection implements rpc.Connection {
  constructor(private readonly client: LanguageClient) { }

  postRequest<P, R>(query: rpc.Query<P, R>, params: P & { uri: string }): Promise<R> {
    return this.client.sendRequest(AgdaQuery, { ...params, kind: query.kind }) as Promise<R>;
  }
}
export let client: LanguageClient;
export let agda: rpc.Connection;

class AgdaTokenProvider implements DocumentSemanticTokensProvider {
  private readonly emitter: EventEmitter<void> = new EventEmitter();
  readonly onDidChangeSemanticTokens: Event<void> = this.emitter.event;

  constructor(private readonly client: LanguageClient) {
    client.onRequest(SemanticTokensRefreshRequest.type, () => {
      this.emitter.fire();
    });
  }

  async provideDocumentSemanticTokens(document: TextDocument, _token: CancellationToken): Promise<SemanticTokens> {
    const tokens = await this.client.sendRequest(SemanticTokensRequest.type, {
      textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document)
    });

    const toks = await client.protocol2CodeConverter.asSemanticTokens(tokens);
    return toks!;
  }

  async provideDocumentSemanticTokensEdits(document: TextDocument, _previous: string, token: CancellationToken): Promise<SemanticTokens> {
    return this.provideDocumentSemanticTokens(document, token);
  }
}

const highlight = window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground")
});

let decorations: vscode.TextEditorDecorationType[] = [];

const decorateGoals = ({ goals, uri }: { goals: rpc.Goal[], uri: string }) => {
  const editor = window.visibleTextEditors.find(e => e.document.uri.toString() === uri);
  if (!editor) return;

  decorations.forEach(d => d.dispose());
  decorations = [];

  const rs: vscode.Range[] = [];

  goals.forEach(({ goalId, goalRange }) => {
    const r = client.protocol2CodeConverter.asRange(goalRange);
    rs.push(new vscode.Range(r.start, r.end.translate(0, goalId.toString().length)));
    const dec = window.createTextEditorDecorationType({
      after: {
        contentText: goalId.toString(),
        color: new vscode.ThemeColor("charts.yellow")
      }
    });
    decorations.push(dec);
    editor.setDecorations(dec, [r]);
  });

  editor.setDecorations(highlight, rs);
};

export async function activate(context: ExtensionContext, createClient: (clientOptions: LanguageClientOptions) => LanguageClient | Promise<LanguageClient>) {
  // Register our input provider
  context.subscriptions.push(
    languages.registerHoverProvider(agdaSelector, new InputHoverProvider()),
    languages.registerCompletionItemProvider(agdaSelector, new InputCompletionProvider(), leader),
  );

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    documentSelector: agdaSelector,
    synchronize: {
      configurationSection: "agda",
    }
  };

  // Create the language client and start the client.
  client = await createClient(clientOptions);
  agda = new LanguageClientConnection(client);

  registerServerStatus(context, client);

  SemanticTokensFeature.prototype.register = function () { };
  client.onNotification(AgdaHighlightingInit, ({ legend }) => {
    const decoded = client.protocol2CodeConverter.asSemanticTokensLegend(legend);
    context.subscriptions.push(
      languages.registerDocumentSemanticTokensProvider(agdaSelector, new AgdaTokenProvider(client), decoded)
    );
  });

  // Register our infoview.
  const infoview = new AgdaInfoviewProvider(context, client);
  context.subscriptions.push(window.registerWebviewViewProvider(AgdaInfoviewProvider.viewType, infoview));

  window.onDidChangeTextEditorSelection(e => {
    if (!isAgdaDocument(e.textEditor.document)) return;

    if (e.selections.length === 1) {
      void agda.postRequest(rpc.Query.GoalAt, {
        position: e.textEditor.selections[0].start,
        uri: e.textEditor.document.uri.toString(),
      }).then(ip => {
        if (typeof ip !== "number") {
          infoview.allGoals(e.textEditor.document.uri.toString());
        } else {
          infoview.goal(ip, e.textEditor.document.uri.toString());
        }
      });
    }
  });

  const status = window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.tooltip = "Agda";
  context.subscriptions.push(status);
  client.onNotification(AgdaInfoviewRefresh, uri => {
    infoview.refresh(uri);

    void agda.postRequest(rpc.Query.ModuleName, { uri }).then(mod => {
      status.text = `$(check) ${mod}`;
      status.show();
    });
  });

  client.onNotification(AgdaGoals, resp => decorateGoals(resp));

  window.onDidChangeActiveTextEditor(e => {
    if (!e || !isAgdaDocument(e.document)) {
      status.hide();
      infoview.hide();
    } else {
      status.show();
      status.text = "$(loading~spin)";

      void agda.postRequest(rpc.Query.ModuleName, { uri: e.document.uri.toString() }).then(async mod => {
        status.text = `$(check) ${mod}`;

        const uri = e.document.uri.toString();
        const goals = await agda.postRequest(rpc.Query.AllGoals, { types: false, uri });
        decorateGoals({ goals, uri });
      });
    }
  });

  /** Return true if {@code p1} is after {@code p2}. */
  const isAfter = (p1: lsp.Position, p2: lsp.Position) =>
    (p1.line > p2.line) || (p1.line == p2.line && p1.character > p2.character);

  context.subscriptions.push(vscode.commands.registerCommand("agda.nextGoal", async () => {
    const e = window.activeTextEditor;
    if (!e || !isAgdaDocument(e.document) || e.selections.length > 1) return;

    const sel = e.selection;

    const goals = await agda.postRequest(rpc.Query.AllGoals, {
      types: false,
      uri: e.document.uri.toString()
    });
    if (goals.length < 1) return;

    // Find the first goal whose start is after the current position.
    let next = goals.find(({ goalRange: { start, end } }) =>
      isAfter(start, sel.active) && !isAfter(sel.active, end)) ?? goals[0];

    e.revealRange(client.protocol2CodeConverter.asRange(next.goalRange));
    e.selection = new vscode.Selection(
      client.protocol2CodeConverter.asPosition(next.goalRange.start),
      client.protocol2CodeConverter.asPosition(next.goalRange.end),
    );
  }), vscode.commands.registerCommand("agda.prevGoal", async () => {
    const e = window.activeTextEditor;
    if (!e || !isAgdaDocument(e.document) || e.selections.length > 1) return;

    const sel = e.selection;

    const goals = await agda.postRequest(rpc.Query.AllGoals, {
      types: false,
      uri: e.document.uri.toString()
    });
    if (goals.length < 1) return;

    // Find the last goal whose end is before the current position.
    goals.reverse();
    let prev = goals.find(({ goalRange: { end } }) => isAfter(sel.active, end)) ?? goals[0];

    e.revealRange(client.protocol2CodeConverter.asRange(prev.goalRange));
    e.selection = new vscode.Selection(
      client.protocol2CodeConverter.asPosition(prev.goalRange.start),
      client.protocol2CodeConverter.asPosition(prev.goalRange.end),
    );
  }));

  // Start the client. This will also launch the server
  await client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
