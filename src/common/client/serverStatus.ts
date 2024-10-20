import * as vscode from "vscode";
import { BaseLanguageClient, State as ClientState } from 'vscode-languageclient';

import { agdaSelector, assertNever } from '../utils';

/**
 * Display the status of the server (and current Agda version) in the status bar.
 *
 * This is displayed as a LanguageStatusItem, so is not visible by default.
 */
export default (context: vscode.ExtensionContext, client: BaseLanguageClient): void => {
  const serverStatus = vscode.languages.createLanguageStatusItem("agda.serverStatus", agdaSelector);
  serverStatus.name = "Agda";
  serverStatus.detail = "Agda Language Server";
  context.subscriptions.push(serverStatus);

  updateStatus(client, serverStatus);

  client.onDidChangeState(() => updateStatus(client, serverStatus));
}

const updateStatus = (client: BaseLanguageClient, serverStatus: vscode.LanguageStatusItem): void => {
  switch (client.state) {
    case ClientState.Starting:
      serverStatus.busy = true;
      serverStatus.text = "Starting";
      serverStatus.severity = vscode.LanguageStatusSeverity.Information;
      break;
    case ClientState.Stopped:
      serverStatus.busy = false;
      serverStatus.text = "Stopped";
      serverStatus.severity = vscode.LanguageStatusSeverity.Warning;
      break;
    case ClientState.Running:
      const info = client.initializeResult?.serverInfo;

      serverStatus.busy = false;
      serverStatus.text = !info ? "Running" : (info.version ? `${info.name} ${info.version}` : info.name);
      serverStatus.severity = vscode.LanguageStatusSeverity.Information;
      break;
    default:
      assertNever(client.state);
  }
}
