import { type ExtensionContext, Uri, type WebviewView, type WebviewViewProvider, window } from "vscode";

import { BaseLanguageClient as LanguageClient } from "vscode-languageclient";
import { AgdaInfoviewMessage, AgdaQuery } from "../api/methods";
import { FromInfoviewMessage, ToInfoviewMessage } from "../api/rpc";
import { assertNever } from './utils';

export class AgdaInfoviewProvider implements WebviewViewProvider {
  public static readonly viewType = "agda.infoView";

  private view?: WebviewView;

  constructor(private readonly context: ExtensionContext, private readonly client: LanguageClient) {
  }

  resolveWebviewView(webviewView: WebviewView): void | Thenable<void> {
    this.view = webviewView;
    webviewView.show();

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
    };

    webviewView.webview.html = `<html>
      <head>
        <link rel="stylesheet" href="${webviewView.webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "out", "infoview", "styles.css"))}" />
      </head>

      <body>
        <div id="container" style="font-size: var(--vscode-editor-font-size); font-family: var(--vscode-editor-font-family);"></div>
      </body>

      <script src="${webviewView.webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "out", "infoview", "index.js"))}"></script>
    </html>
    `;

    this.context.subscriptions.push(
      webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg as FromInfoviewMessage), undefined, []),
      this.client.onNotification(AgdaInfoviewMessage, m => this.displayMessage(this.client.protocol2CodeConverter.asUri(m.uri), m.message)),
    );
  }

  private post(msg: ToInfoviewMessage) {
    void this.view?.webview.postMessage(msg);
  }

  allGoals(uri: Uri) {
    this.post({ kind: "Navigate", route: "/goals", uri: uri.toString() });
  }

  goal(ip: number, uri: Uri) {
    this.post({
      kind: "Navigate",
      route: `/goal/${ip}`,
      uri: uri.toString(),
    });
  }

  private async handleMessage(msg: FromInfoviewMessage): Promise<void> {
    if (!this.view) return;

    if (msg.kind === "RPCRequest") {
      const resp = await this.client.sendRequest(AgdaQuery, {
        ...msg.params,
        uri: this.client.code2ProtocolConverter.asUri(Uri.parse(msg.params.uri)),
      });

      this.post({
        kind: "RPCReply",
        serial: msg.serial,
        data: resp
      });
    } else if (msg.kind === "GoToGoal") {
      await window.showTextDocument(this.client.protocol2CodeConverter.asUri(msg.uri), {
        selection: this.client.protocol2CodeConverter.asRange(msg.range)
      });
    } else {
      assertNever(msg);
    }
  }

  public refresh(uri: Uri) {
    this.post({
      kind: "Refresh",
      route: "/goals",
      uri: uri.toString(),
    });
  }

  public displayMessage(uri: Uri, msg: string) {
    this.post({
      kind: "Navigate",
      route: "/",
      uri: uri.toString(),
    });
    this.post({
      kind: "RunningInfo",
      message: msg
    });
  }

  public hide() {
    this.post({
      kind: "Navigate",
      route: "/",
      uri: "about:blank"
    });
  }
}
