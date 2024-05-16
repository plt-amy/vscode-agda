import { CancellationToken, Uri, window, WebviewViewProvider, WebviewView, WebviewViewResolveContext, ExtensionContext } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import * as lsp from 'vscode-languageclient/node';

export class AgdaInfoviewProvider implements WebviewViewProvider {
  public static readonly viewType = 'agda.infoView';

  private view?: WebviewView;

  constructor(private readonly context: ExtensionContext, private readonly client: LanguageClient) {
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
      <head>
        <style>
          span.agda.comment { color: var(--vscode-agda-comment); }
          span.agda.keyword { color: var(--vscode-agda-keyword); }
          span.agda.string { color: var(--vscode-agda-string); }
          span.agda.number { color: var(--vscode-agda-number); }
          span.agda.hole { color: var(--vscode-agda-hole); }
          span.agda.symbol { color: var(--vscode-agda-symbol); }
          span.agda.primitiveType { color: var(--vscode-agda-primitiveType); }
          span.agda.bound { color: var(--vscode-agda-bound); }
          span.agda.generalizable { color: var(--vscode-agda-generalizable); }
          span.agda.inductiveconstructor { color: var(--vscode-agda-constructorInductive); }
          span.agda.coinductiveconstructor { color: var(--vscode-agda-constructorCoinductive); }
          span.agda.datatype { color: var(--vscode-agda-datatype); }
          span.agda.field { color: var(--vscode-agda-field); }
          span.agda.function { color: var(--vscode-agda-function); }
          span.agda.module { color: var(--vscode-agda-module); }
          span.agda.postulate { color: var(--vscode-agda-postulate); }
          span.agda.primitive { color: var(--vscode-agda-primitive); }
          span.agda.record { color: var(--vscode-agda-record); }
          span.agda.argument { color: var(--vscode-agda-argument); }
          span.agda.macro { color: var(--vscode-agda-macro); }
          span.agda.pragma { color: var(--vscode-agda-pragma); }
          span.agda.subtree:hover { background-color: var(--vscode-editor-selectionHighlightBackground); }

          span.agda.subtree.collapsed .children { display: none; }
          span.agda.subtree.collapsed::before { content: '...'; }

          div.sections {
            display: flex;
            flex-direction: column;

            gap: 0.5em;

            max-width: 100%;
            max-height: 100%;
          }

          div.lines {
            display: flex;
            flex-direction: column;
          }

          .block {
            display: flex;
            flex-direction: column;
            gap: 0.2em;
          }

          .section {
            width: 100%;
            gap: 0.75em;

            padding-inline: 0.5em;
            padding-block: 0.1ex;
            border-left: 3px solid var(--vscode-agda-function);
            box-sizing: border-box;

            background-color: var(--vscode-sideBar-background);

            overflow-y: auto;
          }

          .section-header {
            font-variant: small-caps;
          }

          summary.section-header::marker {
            font-size: 0.75em;
            text-align: center !important;
          }

          .section ul.entry-list {
            flex-direction: column;
            display: flex;

            list-style-type: none;

            padding-inline-start: 0;
            margin: 0;
          }

          a:hover {
            text-decoration: underline;
          }

          span.agda-container {
            white-space: pre-wrap;
            display: inline-block;
          }

          span.face {
            display: flex;
            gap: 1ex;
          }

          .out-of-scope span.agda {
            color: var(--vscode-agda-comment) !important;
          }

          .out-of-scope-label {
            float: right;
          }

          body, #container {
            max-height: 100vh;
            max-width: 100vh;
          }

          .running-info {
            display: flex;
            flex-direction: column;
          }
          .running-info span {
            white-space: pre-wrap;
          }
          </style>
      </head>

      <body>
        <div id="container" style="font-size: var(--vscode-editor-font-size); font-family: var(--vscode-editor-font-family);"></div>
      </body>

      <script src="${webviewView.webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "out", "infoview", "index.js"))}"></script>
    </html>
    `;

    this.context.subscriptions.push(
      webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), undefined, []),
      this.client.onNotification('agda/infoview/message', (m) => this.displayMessage(m.uri, m.message))
    );
  }

  private post(msg: any) {
    this.view?.webview.postMessage(msg);
  }

  allGoals(uri: string) {
    this.post({ kind: 'Navigate', route: '/goals', uri });
  }

  goal(ip: number, uri: string) {
    this.post({
      kind: 'Navigate',
      route: `/goal/${ip}`,
      uri
    });
  }

  private async handleMessage(msg: any): Promise<void> {
    if (!this.view) return;

    if (msg.kind === 'RPCRequest') {
      console.log('Forwarding request', msg);
      const resp = await this.client.sendRequest('agda/query', msg.params);
      console.log(resp);

      this.view.webview.postMessage({
        kind: 'RPCReply',
        serial: msg.serial,
        data: resp
      });
    } else if (msg.kind === 'GoToGoal') {
      await window.showTextDocument(this.client.protocol2CodeConverter.asUri(msg.uri), {
        selection: this.client.protocol2CodeConverter.asRange(msg.range as lsp.Range)
      });
    }
  };

  public refresh(uri: string) {
    console.log("Handling webview refresh", uri, this.view);
    this.post({
      kind: 'Refresh',
      route: '/goals',
      uri
    });
  }

  public displayMessage(uri: string, msg: string) {
    this.post({
      kind: 'Navigate',
      route: '/',
      uri
    });
    this.post({
      kind: 'RunningInfo',
      message: msg
    })
  }

  public hide() {
    this.post({
      kind: 'Navigate',
      route: '/',
      uri: 'about:blank'
    });
  }
}
