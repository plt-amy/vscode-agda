import {
  CancellationToken, DocumentSemanticTokensProvider, Event, EventEmitter,
  ExtensionContext, SemanticTokens, TextDocument, languages, window
} from "vscode";
import * as vscode from "vscode";
import { SemanticTokensFeature } from "vscode-languageclient/lib/common/semanticTokens";

import {
  LanguageClientOptions,
  SemanticTokensRefreshRequest,
  SemanticTokensRequest,
} from "vscode-languageclient";
import * as lsp from "vscode-languageclient";
import { AbstractLanguageClient as LanguageClient } from "./client";

import * as rpc from "../api/rpc";
import { AgdaInfoviewProvider } from "./AgdaInfoviewProvider";
import { AgdaGoals, AgdaHighlightingInit, AgdaInfoviewRefresh, AgdaQuery } from "../api/methods";
import { isAgdaDocument, agdaSelector } from './utils';

import registerServerStatus from './client/serverStatus';
import { InputCompletionProvider, InputHoverProvider } from './input/providers';
import { leader } from './input/data';

class LanguageClientConnection implements rpc.Connection<vscode.Uri> {
  constructor(private readonly client: LanguageClient) { }

  postRequest<P, R>(query: rpc.Query<P, R>, params: P & { uri: vscode.Uri }): Promise<R> {
    return this.client.sendRequest(AgdaQuery, {
      ...params,
      uri: this.client.code2ProtocolConverter.asUri(params.uri),
      kind: query.kind
    }) as Promise<R>;
  }

  private compare(p1: lsp.Position, p2: lsp.Position) {
    return (p1.line >= p2.line) || (p1.line == p2.line && p1.character >= p2.character);
  }

  private contains(r: lsp.Range, p: lsp.Position) {
    return this.compare(r.start, p) && this.compare(p, r.end);
  }

  public async selectGoal(kind: 'next' | 'prev') {
    const e = window.activeTextEditor;
    if (!e || e.document.uri.scheme !== 'file' || e.selections.length != 1) return;
    if (!e.selection.start.isEqual(e.selection.end)) return;

    const cursor = e.selection.start;

    const goals = await agda.postRequest(rpc.Query.AllGoals, { types: false, uri: e.document.uri });

    if (goals.length < 1) return;

    let goal: rpc.Goal | undefined;

    if (kind === 'next') {
      // Seek from the start and find the first goal that (a) doesn't
      // contain the cursor and (b) starts after the end of the
      // selection
      goal = goals.find(({ goalRange }) =>
        !this.contains(goalRange, cursor) && this.compare(goalRange.start, cursor));

      // If we didn't find any then wrap around to the end
      if (!goal) goal = goals[0];
    } else {
      goals.reverse();

      // Seek from the end and find the last goal that (a) doesn't
      // contain the cursor and (b) ends after the start of the
      // selection
      goal = goals.find(({ goalRange }) =>
        !this.contains(goalRange, cursor) && this.compare(cursor, goalRange.end));

      // If we didn't find any then wrap around to the end
      if (!goal) goal = goals[0];
    }

    // If we didn't find any then either there are no goals or they're all contained in the selection
    if (!goal) return;

    e.revealRange(client.protocol2CodeConverter.asRange(goal.goalRange))
    e.selection = new vscode.Selection(
      client.protocol2CodeConverter.asPosition(goal.goalRange.start),
      client.protocol2CodeConverter.asPosition(goal.goalRange.end),
    );
  }
}
export let client: LanguageClient;
export let agda: LanguageClientConnection;

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

const decorateGoals = (uri: vscode.Uri, goals: rpc.Goal[]) => {
  const editor = window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
  if (!editor) return;

  decorations.forEach(d => d.dispose());
  decorations = [];

  const rs: vscode.Range[] = [];

  goals.forEach(({ goalId, goalRange }) => {
    const r = client.protocol2CodeConverter.asRange(goalRange);
    rs.push(r);
    const dec = window.createTextEditorDecorationType({
      after: {
        contentText: goalId.toString(),
        color: new vscode.ThemeColor("charts.yellow"),
        backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground')
      }
    });
    decorations.push(dec);
    editor.setDecorations(dec, [r]);
  });

  editor.setDecorations(highlight, rs);
};

export async function activate(context: ExtensionContext, createClient: (clientOptions: LanguageClientOptions) => LanguageClient) {
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
  client = createClient(clientOptions);
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
        uri: e.textEditor.document.uri,
      }).then(ip => {
        if (typeof ip !== "number") {
          infoview.allGoals(e.textEditor.document.uri);
        } else {
          infoview.goal(ip, e.textEditor.document.uri);
        }
      });
    }
  });

  const status = window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.tooltip = "Agda";
  context.subscriptions.push(status);
  client.onNotification(AgdaInfoviewRefresh, pUrl => {
    const uri = client.protocol2CodeConverter.asUri(pUrl);
    infoview.refresh(uri);

    void agda.postRequest(rpc.Query.ModuleName, { uri }).then(mod => {
      status.text = `$(check) ${mod}`;
      status.show();
    });
  });

  client.onNotification(AgdaGoals, resp => decorateGoals(client.protocol2CodeConverter.asUri(resp.uri), resp.goals));

  window.onDidChangeActiveTextEditor(e => {
    if (!e || !isAgdaDocument(e.document)) {
      status.hide();
      infoview.hide();
    } else {
      status.show();
      status.text = "$(loading~spin)";

      const uri = e.document.uri;
      void agda.postRequest(rpc.Query.ModuleName, { uri }).then(async mod => {
        status.text = `$(check) ${mod}`;
        decorateGoals(uri, await agda.postRequest(rpc.Query.AllGoals, { types: false, uri }));
      });
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('agda.nextGoal', () => agda.selectGoal('next')),
    vscode.commands.registerCommand('agda.prevGoal', () => agda.selectGoal('prev'))
  );

  context.subscriptions.push(vscode.commands.registerCommand('agda.restart', async () => {
    const editor = window.activeTextEditor;
    if (!editor || !isAgdaDocument(editor.document)) return;

    await editor.document.save();
    await client.restart();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('agda.reload', async () => {
    const editor = window.activeTextEditor;
    if (!editor || !isAgdaDocument(editor.document)) return;
    await editor.document.save();

    await client.sendRequest(lsp.ExecuteCommandRequest.type, {
      command: 'reload',
      arguments: [client.code2ProtocolConverter.asUri(editor.document.uri)]
    })
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
