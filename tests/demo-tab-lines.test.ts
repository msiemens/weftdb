// Three tabs of one demo, sharing one storage `SharedWorker` and holding a line to the relay each.
//
// A demo gives every tab a namespace of its own, so one storage worker holds a client per tab and
// each of those clients wants a session of its own. What a session runs over is the port its tab
// transferred in, and what follows from that is what this file is about: a tab reaches the relay
// over its own port, a tab is woken when another tab pushes, and a tab that has gone offline is
// the only device that stops syncing.
//
// Everything is the shipped assembly except the browser: the demo's storage worker, the demo's
// relay and the library's client and session are real, and `node:worker_threads` channels carry
// both the worker protocol and the relay's.
import assert from "node:assert/strict";
import { test } from "vitest";
import { fieldName, rowId, tableName, txnId, type WireValue } from "weftdb/core";
import { schema } from "weftdb-demo-todo/schema";
import { DEMO } from "weftdb-demo-todo/scope";
import { DemoBrowser, type DemoTab } from "./demo-fixtures.ts";
import { waitFor } from "./multitab-fixtures.ts";

const TODOS = tableName("todos");
const TITLE = fieldName("title");

test("a tab is woken by another tab's push, and pulls it without being asked", async (t) => {
  const browser = new DemoBrowser({ schema, demo: DEMO });
  t.onTestFinished(() => browser.close());
  const first = await browser.tab("first");
  const second = await browser.tab("second");
  const third = await browser.tab("third");

  await add(first, "todo-1", "buy milk");
  await first.database.weft.source.sync();

  // Neither of these syncs. The relay tells every connected tab but the one that pushed, and being
  // told is the whole of why a tab updates while nobody is touching it. The notice arrives on that
  // tab's own port, so a tab reaches this state only if the worker is holding the port it handed in.
  for (const [name, tab] of [
    ["second", second],
    ["third", third],
  ] as const) {
    // Shorter than the fixture's blind poll, so the relay's notice is the only thing that can
    // satisfy it inside the window.
    await waitFor(() => titles(tab).includes("buy milk"), `${name} was never woken by the first tab's push`, 3_000);
  }
});

test("one tab going offline leaves every other tab syncing", async (t) => {
  const browser = new DemoBrowser({ schema, demo: DEMO });
  t.onTestFinished(() => browser.close());
  const first = await browser.tab("first");
  const second = await browser.tab("second");
  const third = await browser.tab("third");

  first.database.setOnline(false);

  await add(second, "todo-2", "still connected");
  await second.database.weft.source.sync();
  await waitFor(
    () => second.database.weft.source.status()?.pending === 0,
    "the second tab could not push while another tab was offline",
    5_000,
  );
  await waitFor(() => titles(third).includes("still connected"), "the third tab never saw the second tab's row", 3_000);

  // The tab that clicked offline is the one device that is offline, so its work piles up exactly
  // where a device with the network gone would pile it up.
  await add(first, "todo-3", "written offline");
  await first.database.weft.source.sync();
  await waitFor(() => (first.database.weft.source.status()?.pending ?? 0) > 0, "an offline tab pushed anyway", 5_000);
  assert.equal(titles(third).includes("written offline"), false, "an offline tab reached the relay");
});

test("a tab whose storage worker the browser restarted hands the new one a line to the relay", async (t) => {
  const browser = new DemoBrowser({ schema, demo: DEMO });
  t.onTestFinished(() => browser.close());
  const first = await browser.tab("first");

  await browser.restartStorage();
  // The page hears a closed port, connects again, and says which database it is for. That is the
  // point where the worker it reached either has a line for this device or has nothing.
  await waitFor(() => browser.storage.serving.length === 1, "the tab never reconnected to the new worker", 5_000);

  const second = await browser.tab("second");
  await add(first, "todo-1", "written after the restart");
  await first.database.weft.source.sync();
  // Shorter than the fixture's blind poll, so what the second tab is reading is the relay's notice
  // of a push that reached it.
  await waitFor(
    () => titles(second).includes("written after the restart"),
    "the restarted tab never reached the relay again",
    3_000,
  );
});

function add(tab: DemoTab, id: string, title: string): Promise<void> {
  const values: Record<string, WireValue> = {
    title,
    notes: "",
    done: false,
    rank: "a0",
    due_at: null,
    auto_delete_days: null,
  };
  return tab.database.weft.source.create(TODOS, rowId(id), values, txnId(`create-${id}`));
}

function titles(tab: DemoTab): readonly (WireValue | undefined)[] {
  return tab.database.weft.source.listRows(TODOS).map((row) => row.fields.get(TITLE));
}
