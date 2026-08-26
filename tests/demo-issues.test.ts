// The issues demo, driven through its own controls. What this covers that `demo.test.ts` does
// not is the part of the schema the todo list has no use for: relationships resolved against
// rows the client already holds, an append-only collection, a nested mapper, a status the list is
// narrowed by in SQL, and the seed a first visit opens on.
import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { JSDOM } from "jsdom";
import { createElement, type ReactNode } from "react";
import { rowId } from "weftdb/core";
import { schema } from "weftdb-demo-issues/schema";
import { DEMO } from "weftdb-demo-issues/scope";
import { commentsTable } from "weftdb-demo-issues/bindings";
import { IssueStore } from "weftdb-demo-issues";
import { DemoBrowser, drain, type TabOptions } from "./demo-fixtures.ts";

function browser(): DemoBrowser {
  return new DemoBrowser({ schema, demo: DEMO });
}

/**
 * A tab. Local storage is shared between the tabs of one browser and session storage is not, which
 * is what makes each tab a device of its own under one visitor's scope — and, through the namespace
 * derived from it, a database of its own.
 */
async function openTab(browser: DemoBrowser, name: string, options: TabOptions = {}): Promise<IssueStore> {
  const { identity, database } = await browser.tab(name, options);
  const store = new IssueStore({ identity, database });
  await store.seed(browser.local);
  await settle(store);
  return store;
}

/** Lets what the seed wrote cross the port and come back, which is when the store can be read. */
async function settle(store: IssueStore): Promise<void> {
  await drain(store, "this tab never drained what it wrote");
}

test("a first visit is seeded, and only the first", async (t) => {
  const world = browser();
  t.onTestFinished(() => world.close());
  const first = await openTab(world, "one");

  assert.equal(first.projectRows().length, 2, "expected two seeded projects");
  assert.equal(first.issueRows().length, 5, "expected five seeded issues");
  assert.deepEqual(
    [...new Set(first.issueRows().map((row) => row.status))].sort(),
    ["closed", "open", "started"],
    "the seed should cover every status",
  );

  const second = await openTab(world, "two");
  assert.equal(first.identity.scopeId, second.identity.scopeId, "both tabs are one visitor");
  assert.notEqual(first.deviceId, second.deviceId, "each tab is its own device");
  assert.equal(world.storage.serving.length, 2, "the second tab was given the first tab's database");

  // Seeded once and reached the second tab by syncing, not by being written again: the guard is a
  // key beside the scope, which every tab of one browser reads.
  await settle(first);
  await settle(second);
  assert.equal(second.projectRows().length, 2, "the second tab should receive the seed by sync");
  assert.equal(first.projectRows().length, 2, "the scope was seeded twice");
});

test("emptying the scope does not bring the seed back", async (t) => {
  const world = browser();
  t.onTestFinished(() => world.close());
  const first = await openTab(world, "one");
  for (const project of first.projectRows()) await first.projects.delete(project.id);
  for (const issue of first.issueRows()) await first.issues.delete(issue.id);
  await settle(first);

  const second = await openTab(world, "two");
  await settle(second);
  assert.equal(second.projectRows().length, 0, "reopening re-seeded a scope the visitor emptied");
});

test("comments are append-only, and an edit to one is refused rather than ignored", async (t) => {
  const world = browser();
  t.onTestFinished(() => world.close());
  const store = await openTab(world, "one");
  const surface = store.comments as unknown as Readonly<Record<string, unknown>>;
  assert.equal(typeof surface["create"], "function");
  assert.equal(surface["update"], undefined, "an event log must not generate update");
  assert.equal(surface["delete"], undefined, "an event log must not generate delete");

  // The schema is what enforces this, not the page. Reaching past the generated mutators posts the
  // edit anyway; the client in the storage worker refuses it, and the refusal reaches the caller as
  // the mutator's own promise rejecting.
  const comment = store.source.listRows(commentsTable)[0];
  assert.ok(comment !== undefined, "the seed should have written comments");
  await assert.rejects(
    () => store.source.update(commentsTable, rowId(comment.id), { body: "edited" }),
    /append-class/u,
    "an edit to an append-class row was accepted in silence",
  );
  await assert.rejects(
    () => store.source.delete(commentsTable, rowId(comment.id)),
    /append-class/u,
    "a delete of an append-class row was accepted in silence",
  );
});

test("deleting a project leaves its issues and does not quarantine anything", async (t) => {
  const world = browser();
  t.onTestFinished(() => world.close());
  const store = await openTab(world, "one");

  const project = store.projectRows()[0];
  assert.ok(project !== undefined);
  const orphaned = store.issueRows().filter((row) => row.project_id === project.id).length;
  assert.ok(orphaned > 0, "the seeded project should have issues");

  await store.projects.delete(project.id);
  await settle(store);
  await settle(store);

  assert.equal(
    store.issueRows().filter((row) => row.project_id === project.id).length,
    orphaned,
    "deleting a project took its issues",
  );
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
    const world = browser();
    const store = await openTab(world, "ui");
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(App, { store }) as ReactNode);
    });

    // Every read crosses the port: the rows come back as a push, and the list's statement is not
    // registered with the worker until the effect that mounts it has run.
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
    const issues = (): readonly Element[] => [...container.querySelectorAll("li.issue")];

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
      await flush();
    };

    await until(() => issues().length === 5, "the seeded issues never reached the list");

    // The joins, on the row: the project name is the `hasOne`, the count is the `hasMany`, and
    // the rail's count is the `hasMany` from the other side.
    assert.equal(container.querySelector(".project-tag")?.textContent, "Loom firmware");
    assert.match(container.querySelector(".comment-count")?.textContent ?? "", /^3/u);
    assert.equal(container.querySelectorAll(".rail .count")[0]?.textContent, "3");

    // The status filter is a compiled statement with a `where` and an `orderBy`, run against SQLite
    // in the storage worker: the list is what it answered rather than what the page kept after
    // throwing rows away. The rail's counts are the join over the whole collection and do not move.
    await click("started");
    await until(() => issues().length === 2, "narrowing to a status did not narrow the list");
    assert.deepEqual(
      [...container.querySelectorAll("li.issue .status")].map((chip) => chip.textContent),
      ["started", "started"],
      "the statement's where let another status through",
    );
    assert.equal(container.querySelectorAll(".rail .count")[0]?.textContent, "3", "a rail count followed the filter");
    await click("closed");
    await until(() => issues().length === 1, "the second status was not a second answer");
    assert.equal(container.querySelector("li.issue .status")?.textContent, "closed");
    await click("Any status");
    await until(() => issues().length === 5, "clearing the filter did not bring the rest back");

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
    await store.dispose();
    await world.close();
  };
});

test("the page renders the joins, narrows by status in SQL, and opens an issue in a modal", async () => {
  await page();
});
