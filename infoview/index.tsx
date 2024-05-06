import { StrictMode, type FunctionComponent } from "react";
import { createRoot } from "react-dom/client";

const Document: FunctionComponent<unknown>  = () => <h1>Hello Agda!</h1>;

createRoot(document.getElementById("container")!).render(<StrictMode><Document /></StrictMode>);
