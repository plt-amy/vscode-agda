import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Route, Routes, useNavigate, useSearchParams, LoaderFunction, useParams, MemoryRouter } from "react-router-dom";

import * as rpc from "../api/rpc";

const vscode = acquireVsCodeApi();

class MessageConnection implements rpc.Connection {
  private readonly pending: Map<number, any> = new Map();
  private next: number = 0;

  constructor() {
    window.addEventListener('message', (ev) => {
      console.log(ev);
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

const agda = new MessageConnection();

const EventNavigation: React.FC<{children?: React.ReactNode}> = ({ children }) => {
  const nav = useNavigate();

  useEffect(() => {
    window.addEventListener('message', (ev) => {
      if (ev.data.kind === 'Navigate') {
        nav(ev.data.route);
      }
    })
  }, []);

  return <> {children} </>;
}

const renderDoc = (doc: rpc.Doc) => <>
  {doc.map(e => {
    if (typeof e === 'string') {
      return <>{e}</>
    } else {
      return <span style={{color: `var(--vscode-agda-${e.tag})`}}>
        {renderDoc(e.children)}
      </span>
    }
  })}
</>

const Doc: React.FC<{ it: rpc.Doc }> = ({ it }) => {
  return <span className="agda-printed">
    {renderDoc(it)}
  </span>
}

const GoalType: React.FC<{ goal: rpc.Goal, uri: string }> = ({ goal }) =>
  <span>
    ?{goal.goalId} : <Doc it={goal.goalType} />
  </span>

const AllGoals = () => {
  const [goals, setGoals] = useState<rpc.Goal[]>();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const uri = searchParams.get("uri"); if (!uri) return;
    agda.postRequest(rpc.Query.AllGoals, {uri}).then((value) => {
      if (value) {
        console.log(value);
        setGoals(value)
      }
    });
  }, [searchParams.get("uri")]);

  return <div style={{display: "flex", flexDirection: "column"}}>
    {...(goals ?? []).map((g) => <GoalType goal={g} uri={searchParams.get("uri")!} />)}
  </div>
};

const goalLoader: LoaderFunction = ({ params }) => {
  console.log(params)
  const id = Number.parseInt(params.id ?? '', 10);
  if (typeof id !== 'number') return null;

  return id;
}

function useQuery<P extends {}, R>(query: rpc.Query<P, R>, param: P & { uri: string }, deps: React.DependencyList = []) {
  const [out, setOut] = useState<R>();

  let seen: Record<any, boolean> = {}
  const depl = [...deps];
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
  console.log(depl)

  useEffect(() => {
    agda.postRequest(query, param).then((value) => setOut(value))
  }, depl);

  return out;
}

const Goal = () => {
  const { id: ids } = useParams<{ id: string }>();
  const id = Number.parseInt(ids ?? '');
  if (typeof id !== 'number') return;

  const [searchParams] = useSearchParams();
  const uri = searchParams.get("uri")!;

  const goal = useQuery(rpc.Query.GoalInfo, {
    uri: uri,
    goal: id
  })

  return <div>
    <span>
      <span>Goal </span>
      <span className="type">
        ?{id} : {goal && <Doc it={goal.goalGoal.goalType} />}
      </span>
    </span>
    <ul>
      {...(goal?.goalContext ?? []).map((e: rpc.Entry) => <li key={e.localName.toString()}>{renderDoc(e.localName)} : <Doc it={e.localType} /></li>)}
    </ul>
  </div>;
}

function Document() {
  return <MemoryRouter>
    <EventNavigation>
      <Routes>
        <Route path="/" element={<AllGoals />} />
        <Route path="/goal/:id" element={<Goal />} />
      </Routes>
    </EventNavigation>
  </MemoryRouter>;
}

createRoot(document.getElementById("container")!).render(<StrictMode>
  <Document />
</StrictMode>);
