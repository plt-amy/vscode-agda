import * as React from "react";
import { StrictMode, } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";

import * as rpc from "../api/rpc";

const vscode = acquireVsCodeApi();

class OpenDocument {
  constructor (public readonly version: number, public readonly uri?: string) {}

  bump(): OpenDocument {
    return new OpenDocument(this.version + 1, this.uri);
  }

  withURI(s: string): OpenDocument {
    return new OpenDocument(this.version, s);
  }

  static empty: OpenDocument = new OpenDocument(0, undefined);
}

const DocumentContext: React.Context<OpenDocument> = React.createContext(OpenDocument.empty);

class MessageConnection implements rpc.Connection {
  private readonly pending: Map<number, any> = new Map();
  private next: number = 0;

  constructor() {
    window.addEventListener('message', (ev) => {
      console.log('XXX', ev);
      if (ev.data.kind === 'RPCReply' && this.pending.get(ev.data.serial)) {
        this.pending.get(ev.data.serial)(ev.data.data)
        this.pending.set(ev.data.serial, null)
      }
    })
  }

  postRequest<P extends {}, R>(query: rpc.Query<P, R>, params: P & { uri: string }): Promise<R> {
    return new Promise((resolve, _reject) => {
      console.log('posting');

      const id = this.next++;
      this.pending.set(id, resolve)

      vscode.postMessage({
        kind:  'RPCRequest',
        serial: id,
        params: Object.assign({}, params, {
          kind: query.kind,
        })
      });
    })
  }
}

function useQuery<P extends {}, R>(query: rpc.Query<P, R>, param: P, deps: React.DependencyList = []) {
  const [out, setOut] = React.useState<R>();
  const doc = React.useContext(DocumentContext);
  console.log('XXX', doc);

  let seen: Record<any, boolean> = {}
  const depl = [...deps, doc.version, doc.uri];
  const explore = (e: any) => {
    if (seen[e]) return;
    seen[e] = true;

    if (typeof e === 'object') {
      for (const k of Object.keys(e)) {
        depl.push(e[k]);
      }
    } else {
      depl.push(e)
    }
  }
  explore(param);
  console.log('XXX', depl)

  React.useEffect(() => {
    if (!doc.uri) return;

    agda.postRequest(query, Object.assign({}, param, { uri: doc.uri })).then((value) => setOut(value))
  }, depl);

  return out;
}

const agda = new MessageConnection();

const EventNavigation: React.FC<{children?: React.ReactNode}> = ({ children }) => {
  const nav = useNavigate();
  const [doc, setDocument] = React.useState<OpenDocument>(OpenDocument.empty);

  React.useEffect(() => {
    window.addEventListener('message', (ev) => {
      let upd = doc ?? OpenDocument.empty, changed = false;
      if (typeof ev.data.uri === 'string' && ev.data.uri !== '') upd = upd.withURI(ev.data.uri), changed = true;
      if (ev.data.kind === 'Refresh') upd = upd.bump(), changed = true;

      if (changed) setDocument(upd)

      if (typeof ev.data.route === 'string') nav(ev.data.route);
    })
  }, []);

  return <DocumentContext.Provider value={doc}>
    {children}
  </DocumentContext.Provider>;
}

const docClasses = ({ style }: { style: string[] }) => ["agda", ...style].join(" ");

const renderDoc = (doc: rpc.Doc) => <>
  {doc.map(e => {
    if (typeof e === 'string') {
      return <>{e}</>
    } else {
      return <span className={docClasses(e)}>
        {renderDoc(e.children)}
      </span>
    }
  })}
</>

const Doc: React.FC<{ it: rpc.Doc }> = ({ it }) => {
  return <span className="agda">
    {renderDoc(it)}
  </span>
}

const GoalType: React.FC<{ goal: rpc.Goal }> = ({ goal }) => {
  const {uri} = React.useContext(DocumentContext);

  const goto = () => vscode.postMessage({
    kind: 'GoToGoal',
    uri,
    range: goal.goalRange
  });

  return <span>
    <a onClick={goto}>?{goal.goalId}</a> : <Doc it={goal.goalType} />
  </span>;
}

const AllGoals = () => {
  const goals = useQuery(rpc.Query.AllGoals, { });

  return <Section title="All Goals">
    <ul className="entry-list">
      {...(goals ?? []).map((g) => <GoalType goal={g} />)}
    </ul>
  </Section>
};

const Section: React.FC<{ title: string, children: React.ReactNode }> =
  ({ title, children }) =>
    <details className="section block" open>
      <summary className="section-header">{title.toLowerCase()}</summary>
      {children}
    </details>

const Entry: React.FC<{ entry: rpc.Local }> = ({ entry }) =>
  <li className={`${!entry.localInScope && "out-of-scope"}`}>
    <div className="lines">
      <span className="agda">
        <Doc it={entry.localBinder} />
        {!entry.localInScope && <span className="out-of-scope-label">Not in scope</span>}
      </span>

      {entry.localValue && <Doc it={entry.localValue} />}
    </div>
  </li>

const Boundary: React.FC<{ boundary: rpc.Doc[] }> = ({ boundary }) =>
  <Section title="Boundary">
    <ul className="entry-list">
      {...boundary.map((face) => <li>
        <Doc it={face} />
      </li>)}
    </ul>
  </Section>

const Goal = () => {
  const { id: ids } = useParams<{ id: string }>();
  const id = Number.parseInt(ids ?? '');
  if (typeof id !== 'number') return;

  const goal = useQuery(rpc.Query.GoalInfo, {
    goal: id
  })
  console.log('YYY', goal);
  let context = goal?.goalContext ?? [];

  return goal && <div className="sections">
    <Section title="Goal">
      <GoalType goal={goal.goalGoal} />
    </Section>

    {goal.goalBoundary && <Boundary boundary={goal.goalBoundary} />}

    {context.length >= 1 && <Section title="Context">
      <ul className="entry-list">
        {...context.map((e: rpc.Local) => <Entry entry={e} />)}
      </ul>
    </Section>}

  </div>;
}

function Document() {
  return <MemoryRouter>
    <EventNavigation>
      <Routes>
        <Route path="/" element={<>Loading...</>} />
        <Route path="/goals" element={<AllGoals />} />
        <Route path="/goal/:id" element={<Goal />} />
      </Routes>
    </EventNavigation>
  </MemoryRouter>;
}

createRoot(document.getElementById("container")!).render(<StrictMode>
  <Document />
</StrictMode>);
