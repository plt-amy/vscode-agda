import { ProtocolNotificationType, ProtocolRequestType, SemanticTokensLegend } from "vscode-languageclient";
import { Goal } from "./rpc";

export type AgdaInfoviewMessageParams = {
  /** The URI of the document that this message came from. */
  uri: string,
  /** The message to display. */
  message: string,
};

/** Display a message in the infoview. */
export const AgdaInfoviewMessage: ProtocolNotificationType<AgdaInfoviewMessageParams, void> = new ProtocolNotificationType("agda/infoview/message");

export type AgdaInfoviewRefreshParams = string;

/** Update the infoview display */
export const AgdaInfoviewRefresh: ProtocolNotificationType<AgdaInfoviewRefreshParams, void> = new ProtocolNotificationType("agda/infoview/refresh");

/** Query the Agda state.  */
export const AgdaQuery: ProtocolRequestType<unknown, unknown, void, void, void> = new ProtocolRequestType("agda/query");

export type AgdaGoalsParams = { goals: Goal[], uri: string };

/** Update the goals in the infoview. */
export const AgdaGoals: ProtocolNotificationType<AgdaGoalsParams, void> = new ProtocolNotificationType("agda/goals");

/** Provide a custom semantic highlighting legend. */
export const AgdaHighlightingInit: ProtocolNotificationType<{ legend: SemanticTokensLegend }, void> = new ProtocolNotificationType("agda/highlightingInit");

