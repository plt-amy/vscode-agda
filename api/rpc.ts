import * as lsp from 'vscode-languageclient/node';
// import { TextEditor } from 'vscode';

export type Fragment = { tag: string, children: Fragment[] } | string
export type Doc = Fragment[]

export type Goal = {
  goalId:    number,
  goalType:  Doc,
  goalRange: lsp.Range
}

export type Entry = {
  localName:        Doc,
  localReifiedName: Doc,
  localType:        Doc
}

export type Context = Entry[]

export type GoalInfo = {
  goalGoal: Goal,
  goalContext: Context,
};

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
