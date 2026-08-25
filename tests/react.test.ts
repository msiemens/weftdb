// The React bindings, rendered by React itself rather than reasoned about.
//
// §8 is mostly claims about rendering: `useSyncExternalStore` must not tear, an unchanged
// `_weft_rev` must hand a component the identical object so `React.memo` can do its job,
// Suspense must resolve, and conflicts must surface from a marker scan. None of that is
// observable without a renderer, so this file installs a DOM and mounts components.
import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { JSDOM } from "jsdom";
import { createElement, memo, useEffect, type ReactNode } from "react";
import {
  fieldName,
  rowId,
  scopeId,
  tableName,
  wireText,
  type FieldName,
  type RowId,
  type TableName,
  type WireValue,
} from "weftdb/core";
import {
  QueryCache,
  rowMapSource,
  SqlQueryUnavailableError,
  useWeftConflicts,
  useWeftQuery,
  useWeftQuerySnapshot,
  useWeftSuspenseQuery,
  type WeftSource,
} from "weftdb-react";
import {
  SubscriptionEngine,
  reactiveSqlQuery,
  compileOnlyKysely,
  type LocalRow,
  type MaterializedRow,
  type QueryKey,
} from "weftdb/client";
import { TASKS, TITLE } from "./property-model.ts";

const NOTES = fieldName("notes");

let render: (element: ReactNode) => Promise<{ readonly text: () => string; readonly unmount: () => Promise<void> }>;

beforeAll(async () => {
  // React needs a document before `react-dom/client` is imported.
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://weft.test" });
  // `navigator` is a getter on the Node global, so these go on by definition rather than
  // assignment.
  for (const [name, value] of [
    ["window", dom.window],
    ["document", dom.window.document],
    ["navigator", dom.window.navigator],
    ["IS_REACT_ACT_ENVIRONMENT", true],
  ] as const) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  render = async (element) => {
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    return {
      text: () => container.textContent ?? "",
      unmount: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  };
});

test("§8.3 a query re-renders when its source notifies, and not before", async () => {
  const cache = new QueryCache<string>();
  cache.values.set("greeting", "first");
  let renders = 0;

  function Greeting(): ReactNode {
    renders += 1;
    return createElement("span", null, useWeftQuery(cache, "greeting") ?? "missing");
  }

  const view = await render(createElement(Greeting));
  assert.equal(view.text(), "first");
  const rendersAfterMount = renders;

  const { act } = await import("react");
  await act(async () => {
    cache.publish("greeting", "second");
  });
  assert.equal(view.text(), "second", "the component did not see the published value");
  assert.equal(renders > rendersAfterMount, true, "publishing did not re-render the component");

  // A publish to an unrelated key must not disturb this subscription.
  const rendersAfterUpdate = renders;
  await act(async () => {
    cache.publish("unrelated", "value");
  });
  assert.equal(renders, rendersAfterUpdate, "an unrelated key re-rendered the component");
  await view.unmount();
});

test("§8.2 an unchanged revision hands the component the identical row object", async () => {
  const engine = new SubscriptionEngine();
  const rows = new Map<string, LocalRow>();
  const first = localRow(rowId("row-1"), "one");
  rows.set(`${TASKS}\0${first.id}`, first);
  const key: QueryKey = { tableName: TASKS, fields: [TITLE], orderBy: TITLE };
  const seen: MaterializedRow[] = [];

  const Row = memo(function Row({ row }: { readonly row: MaterializedRow }): ReactNode {
    // Recording here rather than in the parent proves what `React.memo` actually received.
    seen.push(row);
    return createElement("span", null, wireText(row.fields.get(TITLE) ?? ""));
  });

  function List({ tick }: { readonly tick: number }): ReactNode {
    const snapshot = useWeftQuerySnapshot({ engine, rows }, key);
    return createElement(
      "div",
      { "data-tick": tick },
      ...snapshot.rows.map((row) => createElement(Row, { key: row.id, row })),
    );
  }

  const view = await render(createElement(List, { tick: 0 }));
  assert.equal(view.text(), "one");
  assert.equal(seen.length, 1);

  const { act } = await import("react");
  // Re-render with the row untouched: the identity must survive, so memo skips the child.
  await act(async () => {
    engine.notify();
  });
  const identical = engine.getSnapshot(key, rows.values()).rows[0];
  assert.equal(identical, seen[0], "an untouched row was handed to React as a new object");

  // Now revise it: a new object, and the child re-renders.
  first.fields.set(TITLE, "two");
  first.internals._weft_rev += 1;
  await act(async () => {
    engine.notify();
  });
  assert.equal(view.text(), "two");
  assert.equal(seen.length > 1, true, "a revised row did not reach the component");
  assert.notEqual(seen.at(-1), seen[0], "a revised row kept its old identity");
  await view.unmount();
});

test("§8.2 row identity is isolated by table as well as row id", () => {
  const engine = new SubscriptionEngine();
  const sharedId = rowId("shared");
  const first = localRow(sharedId, "from tasks", TASKS);
  const second = localRow(sharedId, "from notes", tableName("notes"));
  const rows = new Map<string, LocalRow>([
    [`${TASKS}\0${sharedId}`, first],
    [`notes\0${sharedId}`, second],
  ]);

  const taskSnapshot = engine.getSnapshot({ tableName: TASKS, fields: [TITLE] }, rows.values());
  const notesSnapshot = engine.getSnapshot({ tableName: tableName("notes"), fields: [TITLE] }, rows.values());

  assert.equal(taskSnapshot.rows[0]?.fields.get(TITLE), "from tasks");
  assert.equal(
    notesSnapshot.rows[0]?.fields.get(TITLE),
    "from notes",
    "a row from another table was reused from the identity cache",
  );
  assert.notEqual(
    taskSnapshot.rows[0],
    notesSnapshot.rows[0],
    "different tables with the same row id shared materialized identity",
  );
});

test("§8.3 a suspense query suspends and then resolves", async () => {
  const cache = new SuspendingCache();
  function Task(): ReactNode {
    return createElement("span", null, useWeftSuspenseQuery(cache, "task"));
  }

  const { Suspense } = await import("react");
  const view = await render(
    createElement(Suspense, { fallback: createElement("span", null, "loading") }, createElement(Task)),
  );
  assert.equal(view.text(), "loading", "the query did not suspend on a cold cache");

  const { act } = await import("react");
  await act(async () => {
    await cache.settle();
  });
  assert.equal(view.text(), "resolved", "the query never resolved");
  await view.unmount();
});

test("§8.3 suspense loads are isolated by source, not just by key", async () => {
  const first = new CountingSuspenseCache("first");
  const second = new CountingSuspenseCache("second");

  function Pair(): ReactNode {
    return createElement(
      "div",
      null,
      createElement(SuspenseBoundary, { cache: first }),
      createElement(SuspenseBoundary, { cache: second }),
    );
  }

  const { Suspense } = await import("react");
  function SuspenseBoundary({ cache }: { readonly cache: CountingSuspenseCache }): ReactNode {
    return createElement(
      Suspense,
      { fallback: createElement("span", null, "loading") },
      createElement(function Item(): ReactNode {
        return createElement("span", null, useWeftSuspenseQuery(cache, "shared-key"));
      }),
    );
  }

  const view = await render(createElement(Pair));
  assert.equal(first.loads, 1, "the first source was not asked to load");
  assert.equal(second.loads, 1, "a source with the same key reused another source's suspense promise");
  await view.unmount();
});

test("§6 conflicts surface from a marker scan in the rendered tree", async () => {
  const clean = materialized(rowId("clean"), "no markers here");
  const conflicted = materialized(
    rowId("conflicted"),
    "<<<<<<< WEFT_LOCAL\nmine\n=======\ntheirs\n>>>>>>> WEFT_REMOTE",
  );

  function Conflicts({ rows }: { readonly rows: readonly MaterializedRow[] }): ReactNode {
    const found = useWeftConflicts(rows);
    return createElement("span", null, found.map((record) => `${record.row.id}:${record.field}`).join(","));
  }

  const view = await render(createElement(Conflicts, { rows: [clean, conflicted] }));
  assert.equal(view.text(), `${conflicted.id}:${NOTES}`);
  await view.unmount();
});

test("§8.3 an unmounted component stops receiving notifications", async () => {
  const cache = new QueryCache<string>();
  cache.values.set("key", "value");
  let renders = 0;
  function Watcher(): ReactNode {
    renders += 1;
    useEffect(() => undefined, []);
    return createElement("span", null, useWeftQuery(cache, "key") ?? "");
  }

  const view = await render(createElement(Watcher));
  await view.unmount();
  const rendersAtUnmount = renders;

  const { act } = await import("react");
  await act(async () => {
    cache.publish("key", "after unmount");
  });
  assert.equal(renders, rendersAtUnmount, "an unmounted component was still subscribed");
  assert.equal(cache.listeners.size, 0, "the subscription was not released");
});

test("§8.3 a device with no SQL database says so rather than reading back an empty statement", () => {
  // One source type covers both read paths, so a device persisting through `WebStorageClientStore`
  // still has to answer `select`. Answering with no rows would be indistinguishable from a
  // statement that matched nothing, which is a list that renders empty and never explains itself.
  const engine = new SubscriptionEngine();
  const rows = new Map<string, LocalRow>();
  const source: WeftSource = rowMapSource({ engine, rows }, scopeId("user-1"));

  assert.equal(source.engine, engine);
  assert.equal(source.rows, rows);
  assert.equal(source.scopeId, "user-1");

  const statements = compileOnlyKysely<{ tasks: { id: string; scope_id: string } }>();
  const query = reactiveSqlQuery({
    tableName: TASKS,
    query: statements.selectFrom("tasks").select("id").where("scope_id", "=", "user-1"),
  });
  assert.throws(() => source.select(query), SqlQueryUnavailableError);
});

/** A suspense source whose promise resolves when the test says so. */
class SuspendingCache {
  #value: string | undefined;
  #resolve: (() => void) | undefined;
  readonly #listeners = new Map<string, Set<() => void>>();

  getSnapshot(_key: string): string | undefined {
    return this.#value;
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => listeners.delete(listener);
  }

  load(_key: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.#resolve = () => {
        this.#value = "resolved";
        for (const listeners of this.#listeners.values()) for (const listener of listeners) listener();
        resolve("resolved");
      };
    });
  }

  async settle(): Promise<void> {
    this.#resolve?.();
    await Promise.resolve();
  }
}

class CountingSuspenseCache {
  readonly value: string;
  loads = 0;
  readonly #listeners = new Map<string, Set<() => void>>();

  constructor(value: string) {
    this.value = value;
  }

  getSnapshot(_key: string): string | undefined {
    return undefined;
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => listeners.delete(listener);
  }

  load(_key: string): Promise<string> {
    this.loads += 1;
    return new Promise(() => undefined);
  }
}

function localRow(id: RowId, title: string, table: TableName = TASKS): LocalRow {
  return {
    id,
    scopeId: scopeId("react-scope"),
    tableName: table,
    created: "2024-01-01T00:00:00.000Z",
    fields: new Map<FieldName, WireValue>([[TITLE, title]]),
    internals: {
      _weft_first_synced_at: null,
      _weft_rev: 1,
      _weft_dirty: 0,
      hlc: new Map(),
      diff3Base: new Map(),
    },
  };
}

function materialized(id: RowId, notes: string): MaterializedRow {
  return {
    id,
    scope_id: scopeId("react-scope"),
    created: "2024-01-01T00:00:00.000Z",
    fields: new Map<FieldName, WireValue>([[NOTES, notes]]),
  };
}
