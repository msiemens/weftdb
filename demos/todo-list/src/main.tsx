import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { TodoStore } from "./store.ts";
import "./style.css";

const container = document.querySelector("#root");
if (container === null) throw new Error("the page has no #root to mount into");

// One store per tab, opened from whatever this tab left in local storage last time.
createRoot(container).render(
  <StrictMode>
    <App store={TodoStore.open(window)} />
  </StrictMode>,
);
