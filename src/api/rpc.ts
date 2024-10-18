import type * as lsp from "vscode-languageclient";

export type Uri = string;

export type Fragment = { style: string[], children: Fragment[] } | string
export type Doc = Fragment[]

export type Goal = {
  goalId:    number,
  goalType:  Doc,
  goalRange: lsp.Range,
}

export type LocalFlag =
  { tag: "NotInScope" } |
  { tag: "Inaccessible", contents: Relevance } |
  { tag: "Erased" } |
  { tag: "Instance" }

export type Local = {
  localBinder:      Doc,
  localBindingSite: lsp.Range | null,
  localValue:       Doc | null,
  localFlags:       LocalFlag[] | null,
  localHiding:      Hiding,
  localModality:    Modality,
}

export type Modality = {
  modRelevance: Relevance,
  modQuantity:  Quantity,
  modCohesion:  Cohesion,
}

export type Context = Local[]

export type GoalInfo = {
  goalGoal:        Goal,
  goalContext:     Context,
  goalBoundary:    Doc[] | null,
  goalConstraints: Doc[],
};

export type Relevance = "Relevant"  | "NonStrict"  | "Irrelevant";
export type Quantity  = "Quantity0" | "Quantity1"  | "Quantityω";
export type Cohesion  = "Flat"      | "Continuous" | "Sharp";
export type Hiding    = "Hidden"    | "Instance"   | "NotHidden";

export type Rewrite = "AsIs" | "Instantiated" | "HeadNormal" | "Simplified" | "Normalised";

export class Query<P, R> {
  readonly _: [P, R] | undefined;
  private constructor(public readonly kind: keyof Queries) { }

  public static GoalAt: Query<{ position: lsp.Position }, number | null> = new Query("GoalAt");
  public static AllGoals: Query<{ types: boolean }, Goal[]> = new Query("AllGoals");
  public static GoalInfo: Query<{ goal: number }, GoalInfo> = new Query("GoalInfo");
  public static ModuleName: Query<object, Doc | null> = new Query("ModuleName");
}

type Queries = {
  GoalAt: typeof Query.GoalAt,
  AllGoals: typeof Query.AllGoals,
  GoalInfo: typeof Query.GoalInfo,
  ModuleName: typeof Query.ModuleName,
}

type QueryParameter = {
  [K in keyof Queries]: Queries[K] extends Query<infer P, infer _> ? P & { kind: K, uri: Uri } : never;
}


export interface Connection<Uri> {
  postRequest<P, R>(query: Query<P, R>, params: P & { uri: Uri }): Promise<R>;
}

type FromInfoviewMessages = {
  RPCRequest: {
    serial: number,
    params: QueryParameter[keyof Queries],
  },

  GoToGoal: {
    uri: Uri,
    range: lsp.Range,
  },
}

export type FromInfoviewMessage = ({ [K in keyof FromInfoviewMessages]: { kind: K } & FromInfoviewMessages[K] })[keyof FromInfoviewMessages];

type ToInfoviewMessages = {
  /** A reply to an `RPCReques` message.
   */
  RPCReply: {
    serial: number,
    data: unknown,
  },
  /** Navigate to a page on the infoview. */
  Navigate: {
    route: string,
    uri: Uri,
  },
  /** Navigate or refresh a page on the infoview. */
  Refresh: {
    route: string,
    uri: Uri,
  },
  /** Print a message to the infoview. */
  RunningInfo: {
    message: string,
  }
}

export type ToInfoviewMessage = ({ [K in keyof ToInfoviewMessages]: { kind: K } & ToInfoviewMessages[K] })[keyof ToInfoviewMessages];
