/*
 * The todo demo, mounted as an Astro island.
 *
 * `demos/todo-list/src/main.tsx` is the standalone version of this file: it finds `#root` and
 * renders the same tree. Here Astro owns the root, so all that is left is opening the store and
 * handing it to `App` — deliberately nothing else, so what a reader sees at `/demos/todo` is the
 * same application `pnpm demo` runs rather than a second copy that can drift.
 *
 * `TodoStore.open(window)` elects this tab, starts its storage worker and hydrates the rows out of
 * it, so it can only run in the browser and it does not answer straight away. The route mounts this
 * with `client:only="react"` for the first reason; the second is why the store arrives through an
 * effect rather than out of the render body.
 *
 * The promise is kept per module rather than per component. Opening twice in one tab would be two
 * calls contending for one Web Lock under one namespace, and the second of them would sit waiting
 * for a port the first is not serving — which is exactly what a `StrictMode` remount would do.
 */
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { App } from "weftdb-demo-todo/app";
import { TodoStore } from "weftdb-demo-todo";
import "weftdb-demo-todo/style.css";

let opening: Promise<TodoStore> | undefined;

export default function TodoDemo(): ReactNode {
  const [store, setStore] = useState<TodoStore | undefined>(undefined);

  useEffect(() => {
    let live = true;
    opening ??= TodoStore.open(window);
    void opening.then((opened) => {
      if (live) setStore(opened);
    });
    return () => {
      live = false;
    };
  }, []);

  if (store === undefined) return <p className="empty">Opening this device's database…</p>;

  return (
    <StrictMode>
      <App store={store} />
    </StrictMode>
  );
}
