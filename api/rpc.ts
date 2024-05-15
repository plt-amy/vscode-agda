import * as lsp from 'vscode-languageclient/node';
// import { TextEditor } from 'vscode';

export type Fragment = { style: string[], children: Fragment[] } | string
export type Doc = Fragment[]

export type Goal = {
  goalId:    number,
  goalType:  Doc,
  goalRange: lsp.Range
}

export type Local = {
  localBinder:      Doc,
  localBindingSite: lsp.Range | null,
  localValue:       Doc | null,
  localInScope:     boolean,
  localHiding:      Hiding,
  localModality:    Modality
}

export type Modality = {
  modRelevance: Relevance,
  modQuantity:  Quantity,
  modCohesion:  Cohesion,
}

export type Context = Local[]

export type GoalInfo = {
  goalGoal:     Goal,
  goalContext:  Context,
  goalBoundary: Doc[] | null
};

export type Relevance = "Relevant"  | "NonStrict"  | "Irrelevant";
export type Quantity  = "Quantity0" | "Quantity1"  | "Quantityω";
export type Cohesion  = "Flat"      | "Continuous" | "Sharp";
export type Hiding    = "Hidden"    | "Instance"   | "NotHidden";

export type Rewrite = "AsIs" | "Instantiated" | "HeadNormal" | "Simplified" | "Normalised";

export class Query<P extends {}, R> {
  readonly _: [P, R] | undefined;
  private constructor(public readonly kind: string) { }

  public static GoalAt: Query<{ position: lsp.Position }, number | null> = new Query('GoalAt');
  public static AllGoals: Query<{}, Goal[]> = new Query('AllGoals');
  public static GoalInfo: Query<{ goal: number }, GoalInfo> = new Query('GoalInfo');
}


export interface Connection {
  postRequest<P extends {}, R>(query: Query<P, R>, params: P & { uri: string }): Promise<R>;
}
