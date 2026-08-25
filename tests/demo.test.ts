// The demo page, driven through its own buttons by two tabs at once. A page that builds is not
// the same as a page that works, so this mounts the real component tree against the real relay
// handler and clicks through the scenarios the page invites people to try.
import "./tsx-hook.ts";
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { JSDOM } from "jsdom";
import { createElement, type ReactNode } from "react";
import { httpTransport, WebStorageClientStore, type FetchLike, type StorageLike } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { createRelayHandler } from "weftdb/server/relay";
import { TOKEN_PROTOCOL_PREFIX } from "weftdb/client";
import { demoVerifier } from "weftdb-demo-shared/auth";
import { tabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "weftdb-demo-todo/schema";
import { DEMO } from "weftdb-demo-todo/scope";
import { TodoStore, type BroadcastChannelLike } from "weftdb-demo-todo";

let openWorld: () => Promise<World>;

interface Tab {
  readonly store: TodoStore;
  readonly root: Element;
  text(): string;
  /** Just the status pills. The guide below them talks about being offline and about unsent
   * work, so matching those words against the whole page proves nothing. */
  badges(): string;
  click(label: string): Promise<void>;
  type(selector: string, value: string): Promise<void>;
  sync(): Promise<void>;
  unmount(): Promise<void>;
}

interface World {
  /** Opens a tab. Reusing a name reopens that tab's storage, which is what a reload does. */
  open(name: string): Promise<Tab>;
  /** Unmounts whatever is still open, so a failed assertion cannot leave a poll loop running. */
  closeAll(): Promise<void>;
  readonly server: WeftServer;
}

/** Storage that behaves like the browser's: string in, string out, nothing shared by accident. */
function memoryStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
  };
}

before(async () => {
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

  openWorld = async () => {
    const server = new WeftServer();
    const handler = createRelayHandler({ server, verifier: demoVerifier });
    const fetchLike: FetchLike = async (input, init) =>
      handler(new Request(`http://relay${input.replace(/^\/api/u, "")}`, init));
    // One shared local storage, one session storage per tab — exactly the browser's split.
    const local = memoryStorage();
    const sessions = new Map<string, StorageLike>();
    const listeners = new Set<() => void>();
    const openTabs = new Set<Tab>();

    const open = async (name: string): Promise<Tab> => {
      const session = sessions.get(name) ?? memoryStorage();
      sessions.set(name, session);
      const identity = tabIdentity(session, local, { demo: DEMO });
      const persistence = new WebStorageClientStore(local, schema, "weft-demo");
      const channel: BroadcastChannelLike = {
        // Nudges are delivered to the *other* tabs, like a real BroadcastChannel.
        postMessage: () => {
          for (const listener of [...listeners]) listener();
        },
        addEventListener: (_type, listener) => {
          const notify = (): void => listener(new dom.window.MessageEvent("message"));
          listeners.add(notify);
        },
        close: () => undefined,
      };
      const store = new TodoStore({
        identity,
        client: persistence.hydrate(identity.scopeId, identity.deviceId),
        transport: httpTransport({ baseUrl: "/api", token: identity.token, fetch: fetchLike }),
        channel,
      });

      const container = dom.window.document.createElement("div");
      dom.window.document.body.append(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(App, { store }) as ReactNode);
      });

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
      };

      const tab: Tab = {
        store,
        root: container,
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
        sync: async () => {
          await act(async () => {
            await store.sync();
          });
        },
        unmount: async () => {
          openTabs.delete(tab);
          await act(async () => {
            root.unmount();
          });
          container.remove();
        },
      };
      openTabs.add(tab);
      return tab;
    };

    return {
      open,
      server,
      closeAll: async () => {
        for (const tab of [...openTabs]) await tab.unmount();
      },
    };
  };
});

async function addTodo(tab: Tab, title: string): Promise<void> {
  await tab.type("input[aria-label='New todo']", title);
  await tab.click("Add");
}

test("the page mounts empty and names the device this tab is", async (t) => {
  const world = await openWorld();
  t.after(() => world.closeAll());
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

test("a todo added in one tab reaches the other", async (t) => {
  const world = await openWorld();
  t.after(() => world.closeAll());
  const first = await world.open("first");
  const second = await world.open("second");

  await addTodo(first, "buy milk");
  await first.sync();
  await second.sync();

  assert.match(second.text(), /buy milk/u, "the second tab never saw the row");
  assert.match(second.text(), /added/u, "the append-only activity entry did not arrive");
});

test("an offline tab keeps working, and drains when it comes back", async (t) => {
  const world = await openWorld();
  t.after(() => world.closeAll());
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
  assert.match(first.badges(), /unsent/u, "offline work was not marked unsent");
  await second.sync();
  assert.doesNotMatch(second.text(), /write it down/u, "an offline tab still reached the server");

  await first.click("offline");
  await first.sync();
  await second.sync();
  assert.match(second.text(), /write it down/u, "coming back online did not drain the outbox");
  assert.doesNotMatch(first.badges(), /unsent/u, "acknowledged work is still marked unsent");
});

test("two tabs editing the same note line surface both versions, and resolving clears them", async (t) => {
  const world = await openWorld();
  t.after(() => world.closeAll());
  const first = await world.open("first");
  const second = await world.open("second");

  await addTodo(first, "plan the week");
  await first.sync();
  await second.sync();

  await first.click("Notes for plan the week");
  await second.click("Notes for plan the week");
  await first.type("textarea", "Tuesday: send the draft");
  await second.type("textarea", "Tuesday: book the room");

  await second.sync();
  await first.sync();

  const conflicted = first.text();
  assert.match(conflicted, /WEFT_LOCAL/u, "the overlapping edit did not surface");
  assert.match(conflicted, /send the draft/u);
  assert.match(conflicted, /book the room/u);
  assert.match(conflicted, /Two tabs edited the same line/u, "the page did not explain the markers");

  // Resolving is an ordinary edit: there is no conflict record to clear afterwards.
  await first.type("textarea", "Tuesday: send the draft, then book the room");
  await first.sync();
  await second.sync();
  await first.sync();

  for (const [name, tab] of [
    ["first", first],
    ["second", second],
  ] as const) {
    assert.doesNotMatch(tab.text(), /WEFT_LOCAL/u, `${name} still shows markers`);
    assert.match(tab.text(), /then book the room/u, `${name} did not converge on the resolution`);
  }
});

test("edits to different fields both survive", async (t) => {
  const world = await openWorld();
  t.after(() => world.closeAll());
  const first = await world.open("first");
  const second = await world.open("second");

  await addTodo(first, "plan the week");
  await first.sync();
  await second.sync();

  await first.type("input[aria-label='Title of plan the week']", "plan the month");
  await second.click("Mark plan the week done");

  await second.sync();
  await first.sync();
  await second.sync();

  for (const [name, tab] of [
    ["first", first],
    ["second", second],
  ] as const) {
    assert.match(tab.text(), /plan the month/u, `${name} lost the rename`);
    assert.match(tab.text(), /completed/u, `${name} lost the completion`);
  }
});

test("a tab that is started twice keeps working, and reordering moves a row", async (t) => {
  // React runs an effect twice in development. The first cleanup used to close this tab's
  // BroadcastChannel, so every nudge after it threw and the other tabs stopped hearing about
  // anything this one did — and reordering wrote a rank the list then ignored.
  const world = await openWorld();
  t.after(() => world.closeAll());
  const tab = await world.open("first");

  const stop = tab.store.start();
  stop();
  const restart = tab.store.start();
  t.after(() => restart());

  for (const title of ["first", "second", "third"]) {
    await tab.type("input[aria-label='New todo']", title);
    await tab.click("Add");
  }
  await tab.sync();
  assert.deepEqual(
    tab.store.rows().map((row) => row.title),
    ["first", "second", "third"],
  );

  await tab.click("Move third up");
  await tab.sync();
  assert.deepEqual(
    tab.store.rows().map((row) => row.title),
    ["first", "third", "second"],
    "moving a row up did not change the order",
  );

  await tab.click("Move first down");
  await tab.sync();
  assert.deepEqual(
    tab.store.rows().map((row) => row.title),
    ["third", "first", "second"],
    "moving a row down did not change the order",
  );
});

test("a reload keeps unsent work: local storage is the state, not a cache", async (t) => {
  const world = await openWorld();
  t.after(() => world.closeAll());
  const first = await world.open("first");

  await first.click("online");
  await addTodo(first, "survive the reload");
  await first.sync();
  assert.match(first.badges(), /unsent/u);
  const identity = first.store.identity;
  await first.unmount();

  // Same tab name, same session storage: this is the tab reloading, not a new device.
  const reloaded = await world.open("first");
  assert.match(reloaded.text(), /survive the reload/u, "the reload lost the row");
  assert.equal(reloaded.store.identity.deviceId, identity.deviceId, "the reload changed the device identity");
  assert.equal(reloaded.store.identity.label, identity.label);

  // A reloaded tab comes back online and pushes what it was holding, so the proof that the
  // outbox survived is on the server: work made offline, in a tab that was then closed, is
  // there. (What was restored, field by field, is pinned in web-storage.test.ts.)
  await reloaded.sync();
  const stored = world.server.snapshot(reloaded.store.identity.scopeId);
  assert.equal(stored.rows.length, 2, "the offline work did not survive the reload");
  assert.ok(
    stored.fields.some((field) => field.value === "survive the reload"),
    "the row reached the server without the title that was written offline",
  );
  assert.doesNotMatch(reloaded.badges(), /unsent/u, "work restored from storage never reached the server");
});
