// Whether the brokered design works in a browser, using the shipped broker rather than a
// re-implementation of it.
//
// The suite proves the relay's logic in Node, where a `MessagePort` really is transferred but the
// broker runs in-process. What only a browser can answer is whether a port survives a
// `SharedWorker` boundary into a second document's dedicated worker and still answers there. Two
// connections to one `SharedWorker` from this page are what two tabs hold: the browser keys a
// `SharedWorker` by its script URL, so both reach the same instance.
import { WeftBrokerClient } from "weftdb/client";

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const SCOPE = "broker-probe";
const output = document.querySelector<HTMLElement>("#results");
const run = document.querySelector<HTMLButtonElement>("#run");

function render(steps: readonly Step[]): void {
  if (output === null) return;
  const rows = steps
    .map((step) => `| ${step.name} | ${step.ok ? "yes" : "no"} | ${step.detail.replace(/\|/gu, "\\|")} |`)
    .join("\n");
  output.textContent = ["| step | ok | detail |", "| --- | --- | --- |", rows].join("\n");
}

function connectBroker(): MessagePort {
  const shared = new SharedWorker(new URL("./broker-shared.ts", import.meta.url), { type: "module" });
  shared.port.start();
  return shared.port;
}

/** One answer from a port, with a deadline: a port that never arrived answers nothing at all. */
function ask(port: MessagePort, message: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${String(timeoutMs)}ms`)), timeoutMs);
    port.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => {
        clearTimeout(timer);
        resolve(String(event.data));
      },
      { once: true },
    );
    port.postMessage(message);
  });
}

/** Whether a condition came true within a deadline. A message crosses a `SharedWorker` on its own turn. */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function probe(): Promise<void> {
  const steps: Step[] = [];
  const note = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
    render(steps);
  };

  note("userAgent", true, navigator.userAgent);

  if (typeof SharedWorker === "undefined") {
    note("SharedWorker constructible", false, "no SharedWorker, so there is no broker and no design");
    return;
  }
  note("SharedWorker constructible", true, "present");

  // The tab that holds the database. It owns the dedicated worker and hands arriving ports into it.
  const worker = new Worker(new URL("./broker-echo-worker.ts", import.meta.url), { type: "module" });
  const provider = new WeftBrokerClient(connectBroker(), SCOPE);
  provider.onPort((port) => {
    worker.postMessage({ weft: "connect", port }, [port as Transferable]);
  });
  provider.provide();
  note("provider registered", true, "announced itself for this scope");

  // A second document, as far as the broker is concerned: its own connection to the same worker.
  const follower = new WeftBrokerClient(connectBroker(), SCOPE);
  // The succession announcement, armed before anything can trigger it. A Web Lock wakes the next
  // waiter and nobody else, so this is how a tab that is not next in line learns that the worker it
  // holds a port into has gone.
  let successions = 0;
  follower.onProvider(() => {
    successions += 1;
  });
  const brokered = follower.requestPort();

  let refused = false;
  void brokered.refused.then(() => {
    refused = true;
  });

  try {
    const answer = await ask(brokered.port as unknown as MessagePort, "hello from the second tab");
    // The decisive one. A port minted here, sent through a SharedWorker to another connection,
    // handed into a dedicated worker, and answering back to this document.
    note("second tab's port reaches the worker directly", true, answer);
  } catch (error) {
    note(
      "second tab's port reaches the worker directly",
      false,
      refused ? "the broker had no provider to give it to" : error instanceof Error ? error.message : String(error),
    );
    brokered.discard();
    return;
  }

  // A second request, to show the provider serves more than the first comer.
  const third = follower.requestPort();
  try {
    const answer = await ask(third.port as unknown as MessagePort, "and again");
    note("a second port is served too", true, answer);
  } catch (error) {
    note("a second port is served too", false, error instanceof Error ? error.message : String(error));
  }

  // A successor taking over, as the other tabs see it. The tab that took the Web Lock registers
  // with the broker, and the broker is what tells every other connection — which is the only path
  // there is to a tab that is not at the head of the lock queue. It says somebody else is serving,
  // never that the hearer leads: a tab reconnects on it, and only the lock promotes.
  const successor = new WeftBrokerClient(connectBroker(), SCOPE);
  successor.provide();
  const announced = await waitFor(() => successions > 0);
  note(
    "a successor's claim reaches another tab",
    announced,
    announced ? "the follower was told to reconnect" : "the announcement never crossed the SharedWorker",
  );
  successor.dispose();

  // With nobody providing, a request has to be refused rather than left waiting: that is what the
  // open's retry loop reads to tell "no leader yet" from "leader is slow".
  provider.dispose();
  const orphan = follower.requestPort();
  const wasRefused = await Promise.race([
    orphan.refused.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  note("a request with no provider is refused", wasRefused, wasRefused ? "refused" : "left waiting");
  orphan.discard();
}

run?.addEventListener("click", () => {
  run.disabled = true;
  void probe().finally(() => {
    run.disabled = false;
  });
});
