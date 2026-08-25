// Render stability, as a property. Three separate bugs in this repository have been infinite
// render loops — a subscription engine shared by two clients, a query snapshot rebuilt on every
// read, and a decoded row list handed back as a fresh array. Each was found by a person opening
// the page and watching it die, because every existing test asserts what the page *says* and
// none of them assert how many times it had to render to say it.
//
// So: mount the page, drive generated sequences of the things a person can do, and hold it to a
// budget. A loop blows the budget immediately; a merely wasteful render shows up as a number
// that climbs when it should not.
import "./tsx-hook.ts";
import assert from "node:assert/strict";
import test, { before } from "node:test";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { createElement, Profiler, type ReactNode } from "react";
import { httpTransport, WebStorageClientStore, type FetchLike, type StorageLike } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { createRelayHandler } from "weftdb/server/relay";
import { demoVerifier } from "weftdb-demo-shared/auth";
import { tabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "weftdb-demo-todo/schema";
import { DEMO } from "weftdb-demo-todo/scope";
import { TodoStore, type BroadcastChannelLike } from "weftdb-demo-todo";

const RUNS = Number(process.env["WEFT_RENDER_RUNS"] ?? 25);
/**
 * What one action is allowed to cost. A click legitimately commits a few times — the store
 * publishes, the query notifies, React batches what it can — but nothing a person does should
 * cost dozens of renders, and a loop costs thousands.
 */
const COMMITS_PER_ACTION = 12;
const MOUNT_BUDGET = 25;

type Action =
  | { readonly kind: "add"; readonly title: string }
  | { readonly kind: "toggle"; readonly row: number }
  | { readonly kind: "rename"; readonly row: number; readonly title: string }
  | { readonly kind: "notes"; readonly row: number; readonly text: string }
  | { readonly kind: "moveUp"; readonly row: number }
  | { readonly kind: "moveDown"; readonly row: number }
  | { readonly kind: "delete"; readonly row: number }
  | { readonly kind: "offline" }
  | { readonly kind: "sync" };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    arbitrary: fc.record({ kind: fc.constant("add" as const), title: fc.string({ minLength: 1, maxLength: 10 }) }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("toggle" as const), row: fc.nat() }), weight: 2 },
  {
    arbitrary: fc.record({ kind: fc.constant("rename" as const), row: fc.nat(), title: fc.string({ maxLength: 10 }) }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("notes" as const), row: fc.nat(), text: fc.string({ maxLength: 12 }) }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("moveUp" as const), row: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("moveDown" as const), row: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("delete" as const), row: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("offline" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("sync" as const) }), weight: 2 },
);

interface Page {
  commits(): number;
  run(action: Action): Promise<void>;
  rows(): number;
  unmount(): Promise<void>;
}

let openPage: (name: string, shared: Shared) => Promise<Page>;
let newShared: () => Shared;

interface Shared {
  readonly fetch: FetchLike;
  readonly local: StorageLike;
  readonly sessions: Map<string, StorageLike>;
  readonly listeners: Set<() => void>;
  readonly server: WeftServer;
}

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

  newShared = () => {
    const server = new WeftServer();
    const handler = createRelayHandler({ server, verifier: demoVerifier });
    return {
      server,
      local: memoryStorage(),
      sessions: new Map<string, StorageLike>(),
      listeners: new Set<() => void>(),
      fetch: async (input, init) => handler(new Request(`http://relay${input.replace(/^\/api/u, "")}`, init)),
    };
  };

  openPage = async (name, shared) => {
    const session = shared.sessions.get(name) ?? memoryStorage();
    shared.sessions.set(name, session);
    const identity = tabIdentity(session, shared.local, { demo: DEMO });
    const persistence = new WebStorageClientStore(shared.local, schema, "weft-demo");
    const channel: BroadcastChannelLike = {
      postMessage: () => {
        for (const listener of [...shared.listeners]) listener();
      },
      addEventListener: (_type, listener) => {
        shared.listeners.add(() => listener(new dom.window.MessageEvent("message")));
      },
      close: () => undefined,
    };
    const store = new TodoStore({
      identity,
      client: persistence.hydrate(identity.scopeId, identity.deviceId),
      transport: httpTransport({ baseUrl: "/api", token: identity.token, fetch: shared.fetch }),
      channel,
    });

    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    let commits = 0;
    await act(async () => {
      root.render(
        createElement(
          Profiler,
          { id: "page", onRender: () => void (commits += 1) },
          createElement(App, { store }),
        ) as ReactNode,
      );
    });

    const click = async (label: string, index = 0): Promise<void> => {
      const buttons = [...container.querySelectorAll("button")].filter(
        (button) =>
          ((button.textContent ?? "").trim() === label || button.getAttribute("aria-label")?.includes(label)) &&
          !button.disabled,
      );
      const button = buttons[index % Math.max(1, buttons.length)];
      if (button === undefined) return;
      await act(async () => {
        button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
    };
    const typeInto = async (field: Element | null, value: string): Promise<void> => {
      if (field === null) return;
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
    const items = (): readonly Element[] => [...container.querySelectorAll("li.todo")];

    return {
      commits: () => commits,
      rows: () => items().length,
      unmount: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
      run: async (action) => {
        const list = items();
        const target = list.length === 0 ? undefined : list["row" in action ? action.row % list.length : 0];
        switch (action.kind) {
          case "add": {
            await typeInto(container.querySelector("input[aria-label='New todo']"), action.title);
            await click("Add");
            return;
          }
          case "toggle": {
            const check = target?.querySelector("button.check");
            if (check === undefined || check === null) return;
            await act(async () => {
              check.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
            });
            return;
          }
          case "rename": {
            await typeInto(target?.querySelector("input.todo-title") ?? null, action.title);
            return;
          }
          case "notes": {
            const toggle = [...(target?.querySelectorAll("button") ?? [])].find(
              (button) => (button.textContent ?? "").trim() === "notes",
            );
            if (toggle !== undefined) {
              await act(async () => {
                toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
              });
            }
            await typeInto(target?.querySelector("textarea") ?? null, action.text);
            return;
          }
          case "moveUp":
          case "moveDown": {
            const arrow = [...(target?.querySelectorAll("button") ?? [])].find(
              (button) =>
                (button.textContent ?? "").trim() === (action.kind === "moveUp" ? "↑" : "↓") && !button.disabled,
            );
            if (arrow === undefined) return;
            await act(async () => {
              arrow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
            });
            return;
          }
          case "delete": {
            const remove = [...(target?.querySelectorAll("button") ?? [])].find(
              (button) => (button.textContent ?? "").trim() === "×",
            );
            if (remove === undefined) return;
            await act(async () => {
              remove.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
            });
            return;
          }
          case "offline": {
            await click("online");
            await click("offline");
            return;
          }
          case "sync": {
            await act(async () => {
              await store.sync();
            });
            return;
          }
        }
      },
    };
  };
});

test("mounting the page costs a bounded number of renders", async () => {
  const shared = newShared();
  const page = await openPage("first", shared);
  assert.ok(
    page.commits() <= MOUNT_BUDGET,
    `mounting committed ${page.commits()} times, which is not a mount but a loop settling down`,
  );
  await page.unmount();
});

test("no sequence of things a person can do makes the page render without bound", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 14 }), async (actions) => {
      const shared = newShared();
      const page = await openPage("first", shared);
      try {
        const budget = MOUNT_BUDGET + actions.length * COMMITS_PER_ACTION;
        for (const action of actions) {
          await page.run(action);
          // Checked after every action rather than at the end, so the failure names the action
          // that ran away rather than the sequence that contained it.
          assert.ok(
            page.commits() <= budget,
            `${action.kind} pushed the page to ${page.commits()} renders, past the ${budget} a run of ${actions.length} actions is allowed`,
          );
        }
      } finally {
        await page.unmount();
      }
    }),
    { numRuns: RUNS, endOnFailure: true },
  );
});

test("a second tab does not make the first one render without bound", async () => {
  // The first of the three loops was two tabs sharing one subscription engine, where each
  // render evicted the other's cached snapshot. It only appears with two of them open.
  await fc.assert(
    fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 8 }), async (actions) => {
      const shared = newShared();
      const first = await openPage("first", shared);
      const second = await openPage("second", shared);
      try {
        const budget = MOUNT_BUDGET + (actions.length + 4) * COMMITS_PER_ACTION;
        for (const [index, action] of actions.entries()) {
          await (index % 2 === 0 ? first : second).run(action);
          await first.run({ kind: "sync" });
          await second.run({ kind: "sync" });
          for (const [name, page] of [
            ["first", first],
            ["second", second],
          ] as const) {
            assert.ok(
              page.commits() <= budget,
              `the ${name} tab reached ${page.commits()} renders after ${action.kind}, past ${budget}`,
            );
          }
        }
      } finally {
        await first.unmount();
        await second.unmount();
      }
    }),
    { numRuns: Math.max(6, Math.floor(RUNS / 2)), endOnFailure: true },
  );
});
