import * as React from "react";
import { StrictMode, } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";

import * as rpc from "../api/rpc";

const vscode = acquireVsCodeApi();
const postMessage = (msg: rpc.FromInfoviewMessage): void => vscode.postMessage(msg);

class OpenDocument {
  constructor(public readonly version: number, public readonly uri?: string) { }

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
  private readonly pending: Map<number, (data: unknown) => void> = new Map();
  private next: number = 0;

  constructor() {
    window.addEventListener("message", ev => {
      console.log("XXX", ev);

      const msg = ev.data as rpc.ToInfoviewMessage;
      if (msg.kind === "RPCReply" && this.pending.get(msg.serial)) {
        this.pending.get(msg.serial)?.(msg.data);
        this.pending.delete(msg.serial);
      }
    });
  }

  postRequest<P, R>(query: rpc.Query<P, R>, params: P & { uri: string }): Promise<R> {
    return new Promise((resolve, _reject) => {
      console.log("posting");

      const id = this.next++;
      this.pending.set(id, resolve as (data: unknown) => void);

      postMessage({
        kind: "RPCRequest",
        serial: id,
        params: { ...params, kind: query.kind },
      });
    });
  }
}

function useQuery<P, R>(query: rpc.Query<P, R>, param: P, deps: React.DependencyList = []) {
  const [out, setOut] = React.useState<R>();
  const doc = React.useContext(DocumentContext);
  console.log("XXX", doc);

  React.useEffect(() => {
    if (!doc.uri || doc.uri === "about:blank") return;

    void agda.postRequest(query, { ...param, uri: doc.uri }).then(value => setOut(value));
  }, [...deps, doc.uri, doc.version]);

  return out;
}

const agda = new MessageConnection();

const EventNavigation: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const nav = useNavigate();
  const [doc, setDocument] = React.useState<OpenDocument>(OpenDocument.empty);

  React.useEffect(() => {
    window.addEventListener("message", ev => {
      const msg = ev.data as rpc.ToInfoviewMessage;

      let upd = doc ?? OpenDocument.empty, changed = false;
      if(msg.kind === "Navigate" || msg.kind === "Refresh") {
        if (msg.uri !== "") upd = upd.withURI(msg.uri), changed = true;
        if (msg.kind === "Refresh") upd = upd.bump(), changed = true;
        if (changed) setDocument(upd);
        nav(msg.route);
      }
    });
  }, []);

  return <DocumentContext.Provider value={doc}>
    {children}
  </DocumentContext.Provider>;
};

const docClasses = ({ style }: { style: string[] }) => ["agda", ...style].join(" ");

const Collapsible: React.FC<{ children: React.ReactNode, className: string }> = ({ children, className }) => {
  const [open, setOpen] = React.useState(true);
  return <span className={className + (open ? " " : " collapsed")} onClick={e => { e.stopPropagation(); setOpen(!open); }}>
    <span className="children">
      {children}
    </span>
  </span>;
};

const renderDoc = (doc: rpc.Doc) => <>
  {doc.map(e => {
    if (typeof e === "string") {
      return <>{e}</>;
    } else if (e.style.find(x => x === "subtree")) {
      return <Collapsible className={docClasses(e)}>{renderDoc(e.children)}</Collapsible>;
    } else {
      return <span className={docClasses(e)}>
        {renderDoc(e.children)}
      </span>;
    }
  })}
</>;


const Doc: React.FC<{ it: rpc.Doc }> = ({ it }) => {
  return <span className="agda-container">
    {renderDoc(it)}
  </span>;
};

const GoalType: React.FC<{ goal: rpc.Goal }> = ({ goal }) => {
  const { uri } = React.useContext(DocumentContext);

  const goto = () => postMessage({
    kind: "GoToGoal",
    uri: uri!,
    range: goal.goalRange
  });

  return <span style={{ display: "flex", alignItems: "flex-start", gap: "1ex" }}>
    <a onClick={goto}>{`?${goal.goalId}`}</a> : <Doc it={goal.goalType} />
  </span>;
};

const AllGoals = () => {
  const goals = useQuery(rpc.Query.AllGoals, { types: true });

  if (goals && goals.length >= 1) {
    return <div>
      <Section title="Goals">
        <ul className="entry-list" style={{ gap: "1em" }}>
          {...(goals ?? []).map(g => <GoalType goal={g} />)}
        </ul>
      </Section>
    </div>;
  } else if (goals) {
    return <div>
      <Section title="Goals">
        <span className="agda">All done 🎉</span>
      </Section>
    </div>;
  } else {
    return <div>
      <Section title="Goals">
        <span className="agda">Loading...</span>
      </Section>
    </div>;
  }
};

const Section: React.FC<{ title: string, children: React.ReactNode, open?: boolean }> =
  ({ title, children, open }) =>
    <details className="section block" open={(open === undefined) ? true : open}>
      <summary className="section-header">{title.toLowerCase()}</summary>
      {children}
    </details>;

const Entry: React.FC<{ entry: rpc.Local }> = ({ entry }) => {

  const mkFlag = (f: rpc.LocalFlag, index: number) => {
    switch (f.tag) {
      case "NotInScope": return (index === 0) ? "Not in scope" : "not in scope";
      case "Inaccessible": return (index === 0) ? f.contents : f.contents.toLowerCase();
      case "Erased": return (index === 0) ? "Erased" : "erased";
      case "Instance": return (index === 0) ? "Instance" : "instance";
    }
  };

  return <li className={`${!entry.localFlags || "out-of-scope"}`}>
    <div className="lines">
      <span className="agda">
        <Doc it={entry.localBinder} />
        {
          entry.localFlags &&
          entry.localFlags.length >= 1 &&
          <span className="out-of-scope-label">{entry.localFlags.map(mkFlag).join(", ")}</span>
        }
      </span>

      {entry.localValue && <Doc it={entry.localValue} />}
    </div>
  </li>;
};

const Boundary: React.FC<{ boundary: rpc.Doc[] }> = ({ boundary }) =>
  <Section title="Boundary">
    <ul className="entry-list">
      {...boundary.map(face => <li>
        <Doc it={face} />
      </li>)}
    </ul>
  </Section>;

const RunningInfo = () => {
  const doc = React.useContext(DocumentContext);
  const [messages, setMessages] = React.useState<string[]>([]);

  if (!doc.uri || doc.uri === "about:blank") return <></>;

  window.addEventListener("message", ev => {
    const msg = ev.data as rpc.ToInfoviewMessage;
    if (msg.kind === "RunningInfo") {
      setMessages([...messages, msg.message]);
    }
  });

  return <Section title="Loading">
    <div className="running-info">
      {...messages.map(s => <span>{s}</span>)}
    </div>
  </Section>;
};

const Goal = () => {
  const { id: ids } = useParams<{ id: string }>();
  const id = Number.parseInt(ids ?? "");
  if (typeof id !== "number") return;

  const goal = useQuery(rpc.Query.GoalInfo, { goal: id }, [id]);
  console.log("YYY", goal);
  const context = goal?.goalContext ?? [];

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
};

function Document() {
  return <MemoryRouter>
    <EventNavigation>
      <Routes>
        <Route path="/" element={<RunningInfo />} />
        <Route path="/goals" element={<AllGoals />} />
        <Route path="/goal/:id" element={<Goal />} />
      </Routes>
    </EventNavigation>
  </MemoryRouter>;
}

createRoot(document.getElementById("container")!).render(<StrictMode>
  <Document />
</StrictMode>);
