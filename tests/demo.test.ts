// The demo page, driven through its own buttons by two tabs at once. A page that builds is not
// the same as a page that works, so this mounts the real component tree over the real assembly the
// page opens — a storage worker per tab, elected through Web Locks, syncing through the relay that
// runs in the browser — and clicks through the scenarios the page invites people to try.
//
// The two tabs here are two *devices*, and that is the property the whole file rests on. Each takes
// a namespace of its own under the visitor's one scope, so each holds its own database, its own
// outbox and its own device id, and nothing either of them shows the other has arrived by any route
// but the relay.
import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { JSDOM } from "jsdom";
import { createElement, type ReactNode } from "react";
import { fieldName } from "weftdb/core";
import { TOKEN_PROTOCOL_PREFIX, type StorageLike } from "weftdb/client";
import { tabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "weftdb-demo-todo/schema";
import { DEMO } from "weftdb-demo-todo/scope";
import { todoEventsTable } from "weftdb-demo-todo/bindings";
import { TodoStore } from "weftdb-demo-todo";
import { DemoBrowser, drain, memoryStorage, type TabOptions } from "./demo-fixtures.ts";

let openWorld: () => World;

interface Tab {
  readonly store: TodoStore;
  text(): string;
  /** Just the status pills. The guide below them talks about being offline and about unsent
   * work, so matching those words against the whole page proves nothing. */
  badges(): string;
  click(label: string): Promise<void>;
  type(selector: string, value: string): Promise<void>;
  sync(): Promise<void>;
  /** Lets whatever is crossing the port land, and re-renders whatever it moved. */
  flush(): Promise<void>;
  /** Waits for something that has to cross the port before it can be true. */
  until(condition: () => boolean, message: string): Promise<void>;
  unmount(): Promise<void>;
}

interface World {
  /** Opens a tab. Reusing a name reopens that tab's storage, which is what a reload does. */
  open(name: string, options?: TabOptions): Promise<Tab>;
  /** Unmounts whatever is still open, so a failed assertion cannot leave a worker running. */
  closeAll(): Promise<void>;
  readonly browser: DemoBrowser;
}

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://weft.test" });
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
  const { App } = await import("weftdb-demo-todo/app");

  openWorld = () => {
    const browser = new DemoBrowser({ schema, demo: DEMO });
    const openTabs = new Set<Tab>();

    const open = async (name: string, options: TabOptions = {}): Promise<Tab> => {
      const { identity, database } = await browser.tab(name, options);
      // Constructed rather than opened through `TodoStore.open`, so these tests start from an empty
      // list: the seed is what `todo-seed.test.ts` is about, and a page that arrives with four rows
      // on it has nothing left to say about adding the first.
      const store = new TodoStore({ identity, database });

      const container = dom.window.document.createElement("div");
      dom.window.document.body.append(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(App, { store }) as ReactNode);
      });

      // Every write crosses the port twice — the mutator posts and the worker echoes back the rows
      // it moved — so nothing a click did is on screen in the turn the click returned in.
      const flush = async (): Promise<void> => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
        });
      };
      const until = async (condition: () => boolean, message: string): Promise<void> => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if (condition()) return;
          await flush();
        }
        throw new Error(message);
      };

      const click = async (label: string): Promise<void> => {
        const button = [...container.querySelectorAll("button")].find(
          (candidate) =>
            (candidate.textContent ?? "").trim() === label || candidate.getAttribute("aria-label") === label,
        );
        if (button === undefined) throw new Error(`no button "${label}" in this tab`);
        if (button.disabled) throw new Error(`the button "${label}" is disabled`);
        await act(async () => {
          button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        });
        await flush();
      };
      // Typing and then moving on, which is what the page waits for: text fields hold the
      // draft while the caret is in them and become a transaction when it leaves.
      const type = async (selector: string, value: string): Promise<void> => {
        const field = container.querySelector(selector);
        if (field === null) throw new Error(`no field matching ${selector}`);
        const prototype =
          field instanceof dom.window.HTMLTextAreaElement
            ? dom.window.HTMLTextAreaElement.prototype
            : dom.window.HTMLInputElement.prototype;
        await act(async () => {
          field.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
          field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
        await act(async () => {
          field.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
        });
        await flush();
      };

      const tab: Tab = {
        store,
        // What the user can read, which is not the same as `textContent`: a todo's title lives
        // in an input's value, and an input has no child text node to find it in.
        text: () =>
          [
            container.textContent ?? "",
            ...[...container.querySelectorAll("input, textarea")].map(
              (field) => (field as HTMLInputElement | HTMLTextAreaElement).value,
            ),
          ].join("\n"),
        badges: () => [...container.querySelectorAll(".badge")].map((badge) => badge.textContent ?? "").join(" "),
        click,
        type,
        flush,
        until,
        sync: async () => {
          await act(async () => {
            await store.sync();
          });
          await flush();
        },
        unmount: async () => {
          openTabs.delete(tab);
          await act(async () => {
            root.unmount();
          });
          container.remove();
          await store.dispose();
        },
      };
      openTabs.add(tab);
      return tab;
    };

    return {
      open,
      browser,
      closeAll: async () => {
        for (const tab of [...openTabs]) await tab.unmount();
        browser.close();
      },
    };
  };
});

async function addTodo(tab: Tab, title: string): Promise<void> {
  await tab.type("input[aria-label='New todo']", title);
  await tab.click("Add");
  await tab.until(() => tab.text().includes(title), `the composer never wrote "${title}"`);
}

test("the page mounts empty and names the device this tab is", async (t) => {
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const tab = await world.open("first");
  assert.match(tab.text(), /Nothing on the list/u);
  assert.match(tab.badges(), /tab 1/u, "the tab does not say which device it is");
});

test("tabs that race for the same ordinal are still telling themselves apart", () => {
  // Local storage has no atomic increment, so two tabs opening at the same moment both read
  // the same counter and both write the same next value. They are still separate devices, and
  // the label has to say so — otherwise two of them look like one and the merges make no sense
  // to whoever is watching.
  const contended: StorageLike = { getItem: () => "2", setItem: () => undefined, removeItem: () => undefined };
  const first = tabIdentity(memoryStorage(), contended, { demo: DEMO });
  const second = tabIdentity(memoryStorage(), contended, { demo: DEMO });

  assert.match(first.label, /^tab 3/u);
  assert.match(second.label, /^tab 3/u, "the ordinals did not actually collide, so this proves nothing");
  assert.notEqual(first.deviceId, second.deviceId, "two tabs became one device");
  assert.notEqual(first.label, second.label, "two devices are showing the same name");
});

test("a tab's token can travel as a WebSocket subprotocol", () => {
  // The browser cannot set headers on a WebSocket, so the token goes in Sec-WebSocket-Protocol as
  // `weft.token.<token>`. RFC 6455 makes those values HTTP tokens, and the `WebSocket` constructor
  // throws on anything else. The failure is silent: the socket never opens, the page falls back to
  // polling, and nothing in the console says why. A separator chosen for the token is the likeliest
  // way an illegal character gets in.
  const separators = /[()<>@,;:\\"/[\]?={} \t]/u;
  const identity = tabIdentity(memoryStorage(), memoryStorage(), { demo: DEMO });

  for (const token of [identity.token, `${TOKEN_PROTOCOL_PREFIX}${identity.token}`]) {
    assert.doesNotMatch(token, separators, `"${token}" is not a legal subprotocol name`);
    assert.doesNotMatch(token, /[^!-~]/u, `"${token}" is not printable ASCII`);
  }
});

test("two tabs of one browser are two devices, not two views of one database", async (t) => {
  // The arrangement everything below rests on, asserted rather than assumed. A namespace and a
  // scope together name a database, so a namespace per tab is a database per tab: two elections,
  // two storage workers, two device ids, two outboxes. Were it one database with two windows on it,
  // every merge these demos are about would be a write and a read of the same rows.
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const first = await world.open("first");
  const second = await world.open("second");

  assert.equal(first.store.identity.scopeId, second.store.identity.scopeId, "the two tabs are not one visitor");
  assert.notEqual(first.store.deviceId, second.store.deviceId, "two tabs were opened as one device");
  assert.equal(world.browser.workers.length, 2, "the second tab was given the first tab's storage worker");
  assert.equal(first.store.database.weft.role, "leader");
  assert.equal(second.store.database.weft.role, "leader", "the second tab stood in the first tab's election");

  // And nothing crosses between them without a sync. The write is in the first tab's own database
  // from the moment it is made, and in nobody else's until the relay has been told.
  await addTodo(first, "in the first tab");
  await first.flush();
  assert.doesNotMatch(second.text(), /in the first tab/u, "a write reached another device with nothing carrying it");
  assert.equal(second.store.rows().length, 0, "the second tab is reading the first tab's database");
});

test("a todo added in one tab reaches the other through the relay", async (t) => {
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const first = await world.open("first");
  const second = await world.open("second");

  await addTodo(first, "buy milk");
  await first.sync();
  await second.sync();
  await second.until(() => second.text().includes("buy milk"), "the second tab never saw the row");

  assert.match(second.text(), /buy milk/u, "the second tab never saw the row");
  assert.match(second.text(), /added/u, "the append-only activity entry did not arrive");
});

test("the activity list is a compiled statement, and it answers with what the where matched", async (t) => {
  // The panel reads `useTodoEventsQuery` with a `where`, an `orderBy` and a `limit`, so the rows
  // it renders were chosen by SQLite in the storage worker rather than by the page after the whole
  // collection had crossed the port. An event of a kind the statement does not name is the proof:
  // it is in the scope, it is in the mirror, and it is not in the list.
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const tab = await world.open("first");

  await addTodo(tab, "write the notes");
  await tab.click("Mark write the notes done");
  await tab.until(() => tab.text().includes("completed"), "the completion was never recorded");

  // Written straight through the mirror, because the page has no button that files one: the whole
  // question is what the statement does with a row the page did not ask for.
  tab.store.todoEvents.create(`event-${crypto.randomUUID()}`, {
    todo_id: "todo-nobody",
    kind: "renamed",
    actor: "somebody",
  });
  await tab.until(
    () => tab.store.source.listRows(todoEventsTable).length === 3,
    "the third event never reached this device",
  );

  const activity = [...tab.text().matchAll(/added|completed|reopened|renamed/gu)].map(([kind]) => kind);
  assert.deepEqual(activity, ["completed", "added"], "the activity list is not the statement's answer, newest first");
  assert.doesNotMatch(tab.text(), /renamed/u, "a row the statement's where excludes was rendered anyway");
});

test("an offline tab keeps working, and drains when it comes back", async (t) => {
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const first = await world.open("first");
  const second = await world.open("second");

  await first.click("online");
  assert.match(first.badges(), /offline/u, "the toggle did not take the tab offline");

  await addTodo(first, "write it down");
  // Visible immediately, before any sync: a local-first client shows what you just did rather
  // than what a server has confirmed.
  assert.match(first.text(), /write it down/u, "a row added offline was not shown until it synced");
  assert.equal(first.store.rows()[0]?.title, "write it down");
  assert.notEqual(first.store.rows()[0]?.id, "", "the new row has no id until it has been pushed");

  await first.sync();
  await first.until(() => /unsent/u.test(first.badges()), "offline work was not marked unsent");
  await second.sync();
  assert.doesNotMatch(second.text(), /write it down/u, "an offline tab still reached the relay");

  await first.click("offline");
  await first.sync();
  await second.sync();
  await second.until(() => second.text().includes("write it down"), "coming back online did not drain the outbox");
  await first.until(() => !/unsent/u.test(first.badges()), "acknowledged work is still marked unsent");
});

test("a browser with no relay to run one in still has a working list", async (t) => {
  // The whole point of the thing. The relay lives in a `SharedWorker`, and a browser that will not
  // give one — or a page opened where nothing is serving — leaves this device with no session at
  // all. Nothing else changes: the database opens, the statements answer, the writes land, and the
  // work waits in the outbox for a relay that may never come.
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const tab = await world.open("first", { relay: false });

  await addTodo(tab, "still works");
  assert.match(tab.text(), /still works/u, "a device with no relay could not write to its own database");
  assert.equal(tab.store.rows().length, 1);
  // The statement ran, which is the half a device with no session might have been expected to lose:
  // the SQL runs against this device's own SQLite and has nothing to do with syncing.
  await tab.until(() => tab.text().includes("added"), "the compiled activity statement answered with nothing");

  // And it says so rather than claiming a connection. `sync` is a verb the page still offers, and
  // over a device with no session it does nothing instead of throwing.
  assert.equal(tab.store.status().live, false, "a device with no relay reported a live connection");
  await tab.sync();
  assert.match(tab.text(), /still works/u);
});

test("two tabs editing the same note line surface both versions, and resolving clears them", async (t) => {
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const first = await world.open("first");
  const second = await world.open("second");

  await addTodo(first, "plan the week");
  await first.sync();
  await second.sync();
  await second.until(() => second.text().includes("plan the week"), "the second tab never saw the row");

  await first.click("Notes for plan the week");
  await second.click("Notes for plan the week");
  await first.type("textarea", "Tuesday: send the draft");
  await second.type("textarea", "Tuesday: book the room");

  await second.sync();
  await first.sync();
  await first.until(() => /WEFT_LOCAL/u.test(first.text()), "the overlapping edit did not surface");

  const conflicted = first.text();
  assert.match(conflicted, /send the draft/u);
  assert.match(conflicted, /book the room/u);
  assert.match(conflicted, /Two tabs edited the same line/u, "the page did not explain the markers");

  // Resolving is an ordinary edit: there is no conflict record to clear afterwards.
  await first.type("textarea", "Tuesday: send the draft, then book the room");
  await first.sync();
  await second.sync();
  await first.sync();
  await second.until(() => second.text().includes("then book the room"), "the second tab never saw the resolution");

  for (const [name, tab] of [
    ["first", first],
    ["second", second],
  ] as const) {
    assert.doesNotMatch(tab.text(), /WEFT_LOCAL/u, `${name} still shows markers`);
    assert.match(tab.text(), /then book the room/u, `${name} did not converge on the resolution`);
  }
});

test("edits to different fields both survive", async (t) => {
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const first = await world.open("first");
  const second = await world.open("second");

  await addTodo(first, "plan the week");
  await first.sync();
  await second.sync();
  await second.until(() => second.text().includes("plan the week"), "the second tab never saw the row");

  await first.type("input[aria-label='Title of plan the week']", "plan the month");
  await second.click("Mark plan the week done");

  await second.sync();
  await first.sync();
  await second.sync();

  for (const [name, tab] of [
    ["first", first],
    ["second", second],
  ] as const) {
    await tab.until(
      () => /plan the month/u.test(tab.text()) && /completed/u.test(tab.text()),
      `${name} did not converge on both edits`,
    );
  }
});

test("a tab that is started twice keeps working, and reordering moves a row", async (t) => {
  // React runs an effect twice in development, so `start` and its cleanup both run before the
  // page settles. Reordering is the part that used to break underneath that: a rank written into
  // a list the page had stopped reading is a row that does not move.
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const tab = await world.open("first");

  const stop = tab.store.start();
  stop();
  const restart = tab.store.start();
  t.onTestFinished(restart);

  for (const title of ["first", "second", "third"]) await addTodo(tab, title);
  await tab.sync();
  assert.deepEqual(
    tab.store.rows().map((row) => row.title),
    ["first", "second", "third"],
  );

  await tab.click("Move third up");
  await tab.until(
    () => tab.store.rows().map((row) => row.title)[1] === "third",
    "moving a row up did not change the order",
  );
  assert.deepEqual(
    tab.store.rows().map((row) => row.title),
    ["first", "third", "second"],
  );

  await tab.click("Move first down");
  await tab.until(
    () => tab.store.rows().map((row) => row.title)[0] === "third",
    "moving a row down did not change the order",
  );
  assert.deepEqual(
    tab.store.rows().map((row) => row.title),
    ["third", "first", "second"],
  );
});

test("a reload keeps unsent work: the device's database is the state, not a cache", async (t) => {
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const first = await world.open("first");

  await first.click("online");
  await addTodo(first, "survive the reload");
  await first.sync();
  await first.until(() => /unsent/u.test(first.badges()), "offline work was not marked unsent");
  const deviceId = first.store.deviceId;
  await first.unmount();

  // Same tab name, same session storage: this is the tab reloading, not a new device. It elects
  // itself again, starts a worker again, and opens the database the tab before it left behind.
  const reloaded = await world.open("first");
  await reloaded.until(() => reloaded.text().includes("survive the reload"), "the reload lost the row");
  assert.equal(reloaded.store.deviceId, deviceId, "the reload changed the device identity");
  assert.equal(reloaded.store.identity.label, first.store.identity.label);

  // A reloaded tab comes back online and pushes what it was holding, so the proof that the
  // outbox survived is what the *other* device can see: work made offline, in a tab that was then
  // closed, reaches a second tab that was never open at the time.
  await drain(reloaded.store, "the reloaded tab never pushed what it was holding");
  const witness = await world.open("second");
  await witness.sync();
  await witness.until(() => witness.text().includes("survive the reload"), "the offline work never reached the relay");
  assert.doesNotMatch(reloaded.badges(), /unsent/u, "work restored from storage never reached the relay");
});

test("a mutation the worker refuses is reported rather than silently having no effect", async (t) => {
  // A mutator posts and returns `void`, so a refusal has nowhere to surface but `onError`. The
  // event log is where the demo can arrange one: its rows are append-class, and the client in the
  // worker refuses an edit to one whatever the page sends.
  const world = openWorld();
  t.onTestFinished(() => world.closeAll());
  const refused: Error[] = [];
  const tab = await world.open("first", { onError: (error) => refused.push(error) });

  await addTodo(tab, "one thing");
  const [event] = tab.store.source.listRows(todoEventsTable);
  assert.ok(event !== undefined, "adding a todo did not write an activity entry");
  tab.store.source.update(todoEventsTable, event.id, { actor: "somebody else" });

  await tab.until(() => refused.length > 0, "an edit to an append-class row was accepted in silence");
  assert.match(refused[0]?.message ?? "", /append-class/u, "the refusal did not say why");
  // And the row is as it was: nothing is applied on the page first, so nothing had to be undone.
  await tab.flush();
  assert.equal(
    tab.store.source.getRow(todoEventsTable, event.id)?.fields.get(fieldName("actor")),
    tab.store.identity.label,
    "the refused edit was applied on the page anyway",
  );
});
