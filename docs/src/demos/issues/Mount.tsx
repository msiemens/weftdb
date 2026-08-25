/*
 * The issues demo, mounted as an Astro island.
 *
 * `demos/issues/src/main.tsx` is the standalone version of this file: it finds `#root` and renders
 * the same tree. Here Astro owns the root, so all that is left is opening the store and handing it
 * to `App` — deliberately nothing else, so what a reader sees at `/demos/issues` is the same
 * application `pnpm --filter weftdb-demo-issues dev` runs rather than a second copy that can drift.
 *
 * `IssueStore.open(window)` reads what this tab left in local storage last time, so it can only run
 * in the browser. The route mounts this with `client:only="react"` for that reason: there is no
 * server-rendered version of a store that is defined by what is already on the device.
 */
import { StrictMode, useState } from "react";
import { App } from "weftdb-demo-issues/app";
import { IssueStore } from "weftdb-demo-issues";
import "weftdb-demo-issues/style.css";

export default function IssuesDemo() {
  // Lazily, and once: under StrictMode a store opened in the render body would be opened twice.
  const [store] = useState(() => IssueStore.open(window));

  return (
    <StrictMode>
      <App store={store} />
    </StrictMode>
  );
}
