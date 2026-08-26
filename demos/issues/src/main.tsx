import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { IssueStore } from "./store.ts";
import "./style.css";

const container = document.querySelector("#root");
if (container === null) throw new Error("the page has no #root to mount into");

// One database per tab, opened before anything renders. The rows live in a storage worker and the
// page reads a mirror of them, so there is nothing to show until this tab has hydrated one.
const store = await IssueStore.open(window);

createRoot(container).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
