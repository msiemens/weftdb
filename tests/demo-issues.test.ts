// The issues demo, driven through its own controls. What this covers that `demo.test.ts` does
// not is the part of the schema the todo list has no use for: relationships resolved against
// rows the client already holds, an append-only collection, a nested mapper, and the seed a
// first visit opens on.
import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { JSDOM } from "jsdom";
import { createElement, type ReactNode } from "react";
import { httpTransport, WebStorageClientStore, type FetchLike, type StorageLike } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { createRelayHandler } from "weftdb/server/relay";
import { demoVerifier } from "weftdb-demo-shared/auth";
import { tabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "weftdb-demo-issues/schema";
import { DEMO } from "weftdb-demo-issues/scope";
import { IssueStore } from "weftdb-demo-issues";

/** Storage that behaves like the browser's: string in, string out, nothing shared by accident. */
function memoryStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
  };
}

/** One relay, and stores that reach it the way the page does. */
function relay(): FetchLike {
  const server = new WeftServer();
  const handler = createRelayHandler({ server, verifier: demoVerifier });
  return async (input, init) => handler(new Request(`http://relay${input.replace(/^\/api/u, "")}`, init));
}

/**
 * A tab. `local` is shared between the tabs of one browser and `session` is not, which is what
 * makes each tab a device of its own under one visitor's scope.
 */
function openTab(local: StorageLike, fetch: FetchLike, slot: string): IssueStore {
  const identity = tabIdentity(memoryStorage(), local, { demo: DEMO });
  const persistence = new WebStorageClientStore(local, schema, `weft-demo-${slot}`);
  const store = new IssueStore({
    identity,
    client: persistence.hydrate(identity.scopeId, identity.deviceId),
    transport: httpTransport({ baseUrl: "/api", token: identity.token, fetch }),
  });
  store.seed(local);
  return store;
}

test("a first visit is seeded, and only the first", async () => {
  const fetch = relay();
  const local = memoryStorage();
  const first = openTab(local, fetch, "one");

  assert.equal(first.projectRows().length, 2, "expected two seeded projects");
  assert.equal(first.issueRows().length, 5, "expected five seeded issues");
  assert.deepEqual(
    [...new Set(first.issueRows().map((row) => row.status))].sort(),
    ["closed", "open", "started"],
    "the seed should cover every status",
  );

  const second = openTab(local, fetch, "two");
  assert.equal(second.projectRows().length, 0, "a second tab seeded the scope again");
  assert.equal(first.identity.scopeId, second.identity.scopeId, "both tabs are one visitor");
  assert.notEqual(first.identity.deviceId, second.identity.deviceId, "each tab is its own device");

  await first.sync();
  await second.sync();
  assert.equal(second.projectRows().length, 2, "the second tab should receive the seed by sync");
});

test("emptying the scope does not bring the seed back", async () => {
  const fetch = relay();
  const local = memoryStorage();
  const first = openTab(local, fetch, "one");
  for (const project of first.projectRows()) first.projects.delete(project.id);
  for (const issue of first.issueRows()) first.issues.delete(issue.id);
  await first.sync();

  const second = openTab(local, fetch, "two");
  await second.sync();
  assert.equal(second.projectRows().length, 0, "reopening re-seeded a scope the visitor emptied");
});

test("comments are append-only", async () => {
  const fetch = relay();
  const store = openTab(memoryStorage(), fetch, "one");
  const surface = store.comments as unknown as Readonly<Record<string, unknown>>;
  assert.equal(typeof surface["create"], "function");
  assert.equal(surface["update"], undefined, "an event log must not generate update");
  assert.equal(surface["delete"], undefined, "an event log must not generate delete");

  // The schema is what enforces this, not the page: reaching past the generated mutators to the
  // client is refused before the op can reach the outbox.
  await store.sync();
  const comment = store.client.rows.values().find((row) => row.tableName === "comments");
  assert.ok(comment !== undefined, "the seed should have written comments");
  assert.throws(
    () => store.client.update(comment.tableName, comment.id, new Map() as never),
    /append-class/u,
    "an append-class row accepted an edit",
  );
  assert.throws(
    () => store.client.delete(comment.tableName, comment.id),
    /append-class/u,
    "an append-class row accepted a delete",
  );
});

test("deleting a project leaves its issues and does not quarantine anything", async () => {
  const fetch = relay();
  const store = openTab(memoryStorage(), fetch, "one");
  await store.sync();

  const project = store.projectRows()[0];
  assert.ok(project !== undefined);
  const orphaned = store.issueRows(project.id).length;
  assert.ok(orphaned > 0, "the seeded project should have issues");

  store.projects.delete(project.id);
  await store.sync();
  await store.sync();

  assert.equal(store.issueRows(project.id).length, orphaned, "deleting a project took its issues");
  assert.equal(store.status().quarantined, 0, "deleting a project quarantined a change");
});

let page: () => Promise<void>;

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://weft.test" });
  for (const [name, value] of [
    ["window", dom.window],
    ["document", dom.window.document],
    ["navigator", dom.window.navigator],
    // Used to build the selector that checks `aria-labelledby` resolves to the dialog's heading.
    ["CSS", dom.window["CSS"]],
    ["IS_REACT_ACT_ENVIRONMENT", true],
  ] as const) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  // jsdom parses `<dialog>` but implements none of its behaviour: there is no top layer, so
  // `showModal` and `close` are simply absent. The two are stood in for here, tracking the `open`
  // attribute the way the specification says they do, because what these tests check is the
  // component's use of the element rather than the element itself. The focus trap, the inert
  // backdrop and the real Escape path belong to the browser and are not exercised.
  // Another gap: jsdom has no media queries at all. Reporting no match is the answer that
  // exercises the animated path rather than the reduced-motion shortcut around it.
  const win = dom.window as unknown as Record<string, unknown>;
  win["matchMedia"] ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });

  const dialogs = dom.window.HTMLDialogElement.prototype as unknown as Record<string, () => void>;
  dialogs["showModal"] ??= function showModal(this: Element): void {
    this.setAttribute("open", "");
  };
  dialogs["close"] ??= function close(this: Element): void {
    this.removeAttribute("open");
    this.dispatchEvent(new dom.window.Event("close"));
  };

  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { App } = await import("weftdb-demo-issues/app");

  page = async () => {
    const store = openTab(memoryStorage(), relay(), "ui");
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(App, { store }) as ReactNode);
    });

    const button = (label: string): HTMLButtonElement => {
      const found = [...container.querySelectorAll("button")].find(
        (candidate) => (candidate.textContent ?? "").trim() === label || candidate.getAttribute("aria-label") === label,
      );
      if (found === undefined) throw new Error(`no button "${label}" on the page`);
      return found;
    };
    const click = async (label: string): Promise<void> => {
      const target = button(label);
      // A browser focuses a button on mousedown; jsdom moves focus for nothing but an explicit
      // `focus()`. Without this the page is driven with focus parked on `<body>` throughout,
      // which is not a state a person can put it in — and the modal, which records whatever was
      // focused as the element to hand focus back to, would be recording the body.
      target.focus();
      await act(async () => {
        target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
    };

    // The joins, on the row: the project name is the `hasOne`, the count is the `hasMany`, and
    // the rail's count is the `hasMany` from the other side.
    assert.equal(container.querySelector(".project-tag")?.textContent, "Loom firmware");
    assert.match(container.querySelector(".comment-count")?.textContent ?? "", /^3/u);
    assert.equal(container.querySelectorAll(".rail .count")[0]?.textContent, "3");

    // The row's control opens a modal, and the list is still behind it rather than replaced.
    const opener = button("Open Shuttle stalls at row 12");
    await click("Open Shuttle stalls at row 12");
    const dialog = container.querySelector("dialog.detail");
    assert.ok(dialog instanceof dom.window.HTMLDialogElement, "the detail is not a dialog");
    assert.equal(dialog.open, true, "the detail dialog did not open");
    assert.ok(container.querySelector(".issues") !== null, "the list went away behind the modal");

    // Labelled by its own heading rather than by a hand-written string.
    const labelledBy = dialog.getAttribute("aria-labelledby");
    assert.ok(labelledBy !== null, "the dialog has no aria-labelledby");
    assert.match(
      dialog.querySelector(`#${CSS.escape(labelledBy)}`)?.textContent ?? "",
      /Shuttle stalls at row 12/u,
      "aria-labelledby does not point at the dialog's heading",
    );

    // The thread, through the nested mapper, in the order it was written. Ordering by `created`
    // put these in a different order per run, because the seed writes them inside one millisecond
    // and the tie fell through to a random row id.
    assert.equal(dialog.querySelectorAll(".comment").length, 3);
    assert.deepEqual(
      [...dialog.querySelectorAll(".byline .who")].map((who) => who.textContent),
      ["ada", "gerd", "ada"],
      "the thread is not in the order it was written",
    );
    assert.deepEqual(
      [...dialog.querySelectorAll(".comment-body")].map((body) => (body.textContent ?? "").slice(0, 12)),
      ["Happens on t", "That matches", "Patch holds "],
      "the comment bodies are not in the order they were written",
    );
    assert.equal(dialog.querySelectorAll(".comment textarea").length, 0, "a comment was editable");
    assert.equal(
      [...dialog.querySelectorAll("button")].filter((candidate) =>
        (candidate.getAttribute("aria-label") ?? "").startsWith("Delete comment"),
      ).length,
      0,
      "a comment was deletable",
    );

    // Closing returns focus to the control that opened it.
    await click("Close");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    // Both asked as booleans rather than by comparing the elements themselves: a failed
    // `assert.equal` between two DOM nodes builds its diff by inspecting them, and inspecting a
    // live jsdom tree exhausts memory before the runner can report which assertion it was.
    const active = dom.window.document.activeElement;
    assert.equal(container.querySelector("dialog.detail") === null, true, "the detail stayed mounted");
    assert.equal(
      active === opener,
      true,
      `focus did not return to the opener; it is on ${active?.tagName ?? "nothing"}`,
    );

    await act(async () => {
      root.unmount();
    });
  };
});

test("the page renders the joins and opens an issue in a modal", async () => {
  await page();
});
