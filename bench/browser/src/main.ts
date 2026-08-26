// The page. It owns the running order, the failure handling and the table; the durable numbers are
// measured in `worker.ts` and only their samples come back here, so nothing a percentile is taken
// over has crossed a thread boundary after the clock stopped.
//
// Every case is attempted on its own. One that throws is recorded as failed with its message and
// the run carries on: a partial table answers most of the question, and an empty one answers none
// of it.
import { duration, failure, messageOf, perOperation, repeatAsync, type Budget, type CaseRow } from "./harness.ts";
import type { BenchRequest, BenchResponse, DeltaValue, InitValue, SamplesValue } from "./protocol.ts";

/** Database sizes every durable case is measured at. */
const SIZES = [100, 1000, 10000] as const;
/** The size the interactive cases run at — a list long enough to be real, short enough to be common. */
const INTERACTIVE = 1000;
/** How many messages a burst fires without awaiting any of them, which is a fast typist's second. */
const BURST = 20;

/** Round trips need more samples than a mean would, because their p95 is the number that matters. */
const ROUNDTRIP: Budget = { iterations: 200, warmup: 30 };
const WIDE_ROUNDTRIP: Budget = { iterations: 100, warmup: 20 };
const COMMIT: Budget = { iterations: 100, warmup: 20 };
const BURST_BUDGET: Budget = { iterations: 30, warmup: 5 };

/** Whole-dataset cases: a sample costs the dataset, so the sample count falls as the dataset grows. */
function wholeDatasetBudget(size: number): Budget {
  if (size <= 100) return { iterations: 50, warmup: 5 };
  if (size <= 1000) return { iterations: 30, warmup: 3 };
  return { iterations: 10, warmup: 2 };
}

// ---------------------------------------------------------------------------------------------
// The worker, and one request at a time over it.

/**
 * The page's half of the protocol, shaped like `weftdb/client`'s `WorkerPortTransport`: a request
 * id per message and a promise per id, which is what lets a burst have twenty in flight at once.
 */
class BenchWorker {
  readonly #worker: Worker;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.addEventListener("message", (event: MessageEvent<BenchResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (pending === undefined) return;
      this.#pending.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.value);
      else pending.reject(new Error(event.data.error));
    });
    // A module that fails to load surfaces here and nowhere else; without this every case would
    // simply hang on a promise nobody is ever going to settle.
    this.#worker.addEventListener("error", (event: ErrorEvent) => {
      const error = new Error(`the worker failed to load or threw: ${event.message}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  send(body: WithoutId<BenchRequest>): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const request: BenchRequest = { ...body, id };
      this.#worker.postMessage(request);
    });
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

/**
 * Distributive, so each member of the request union keeps its own fields. A plain `Omit` over a
 * union collapses to the keys they share, which here is the discriminant and nothing else.
 */
type WithoutId<T> = T extends { readonly id: number } ? Omit<T, "id"> : never;

// ---------------------------------------------------------------------------------------------
// The page's furniture.

const runButton = element<HTMLButtonElement>("run");
const copyButton = element<HTMLButtonElement>("copy");
const statusLine = element<HTMLElement>("status");
const environmentList = element<HTMLElement>("environment");
const resultsBody = element<HTMLElement>("results");

const results: CaseRow[] = [];
const environment: Record<string, string> = {};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the page is missing #${id}`);
  return found as T;
}

function status(text: string): void {
  statusLine.textContent = text;
}

function describeEnvironment(key: string, value: string): void {
  environment[key] = value;
  const item = document.createElement("li");
  const name = document.createElement("span");
  name.className = "key";
  name.textContent = key;
  const detail = document.createElement("span");
  detail.className = "value";
  detail.textContent = value;
  item.append(name, detail);
  environmentList.append(item);
}

function publish(row: CaseRow): void {
  results.push(row);
  const tr = document.createElement("tr");
  if (row.status === "failed") tr.className = "failed";
  for (const text of [
    row.id,
    row.size === null ? "—" : row.size.toLocaleString("en-US"),
    row.median === null ? "—" : format(row.median),
    row.p95 === null ? "—" : format(row.p95),
    row.samples === 0 ? "—" : String(row.samples),
    row.note,
  ]) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
  }
  resultsBody.append(tr);
}

/** Sub-millisecond numbers need their decimals; a 400 ms one does not. */
function format(value: number): string {
  if (value >= 100) return value.toFixed(1);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

/** Lets the browser paint the status line before the next case blocks the thread on it. */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function attempt(id: string, size: number | null, produce: () => Promise<readonly CaseRow[]>): Promise<void> {
  try {
    for (const row of await produce()) publish(row);
  } catch (error) {
    publish(failure(id, size, messageOf(error)));
  }
}

// ---------------------------------------------------------------------------------------------
// The cases.

/** The floor of a round trip: a message that carries nothing and is answered with nothing. */
async function roundtripEmpty(worker: BenchWorker): Promise<readonly CaseRow[]> {
  const samples = await repeatAsync(async () => {
    const start = performance.now();
    await worker.send({ type: "ping" });
    return performance.now() - start;
  }, ROUNDTRIP);
  return [duration("worker.roundtrip.empty", null, "postMessage there and back, no payload either way", samples)];
}

/** The same trip carrying what an edit's echo would carry back. */
async function roundtripDelta(worker: BenchWorker, rows: number, budget: Budget): Promise<readonly CaseRow[]> {
  const samples = await repeatAsync(async () => {
    const start = performance.now();
    const value = (await worker.send({ type: "delta", rows })) as DeltaValue;
    const elapsed = performance.now() - start;
    if (value.rows.length !== rows) throw new Error(`expected ${rows} rows back, got ${value.rows.length}`);
    return elapsed;
  }, budget);
  return [
    duration(
      `worker.roundtrip.delta.${rows}`,
      null,
      `a ${rows}-row delta of nine-field todos, structured-cloned back to the page`,
      samples,
    ),
  ];
}

async function commitCase(worker: BenchWorker, size: number): Promise<readonly CaseRow[]> {
  const value = (await worker.send({ type: "commit", size, budget: COMMIT })) as SamplesValue;
  return [
    duration(
      "sqlite.commit",
      size,
      "one client.update() with the store attached: field write, row rewrite, outbox rewrite, sync-state upsert, commit",
      value.samples,
    ),
  ];
}

async function hydrateCase(worker: BenchWorker, size: number): Promise<readonly CaseRow[]> {
  const budget = wholeDatasetBudget(size);
  const value = (await worker.send({ type: "hydrate", size, budget })) as SamplesValue;
  return [
    duration(
      "sqlite.hydrate",
      size,
      "cold start: schema check, then every row, tombstone and queued op read back and decoded",
      value.samples,
    ),
  ];
}

/**
 * Fast typing. Twenty edits are posted back to back without awaiting any of them, and the clock
 * runs from the first post until the twentieth reply lands — which is what an echo-mirror design
 * asks a person to wait for before their own keystrokes stop queueing behind each other.
 */
async function burstCase(worker: BenchWorker, size: number): Promise<readonly CaseRow[]> {
  const samples = await repeatAsync(async () => {
    const start = performance.now();
    const replies: Array<Promise<unknown>> = [];
    for (let index = 0; index < BURST; index += 1) replies.push(worker.send({ type: "edit", size }));
    await Promise.all(replies);
    return performance.now() - start;
  }, BURST_BUDGET);
  return [
    duration(
      `echo.burst${BURST}`,
      size,
      `${BURST} updates posted without awaiting any of them, timed to the last delta received`,
      samples,
    ),
    perOperation(
      `echo.burst${BURST}.perEdit`,
      size,
      "the same distribution divided through: the implied latency of one keystroke in the burst",
      samples,
      BURST,
    ),
  ];
}

/** A request and its answer over BroadcastChannel — item 2's proxy overhead, with nothing behind it. */
async function broadcastRoundtrip(): Promise<readonly CaseRow[]> {
  const proxy = openProxy((request, reply) => {
    reply(request);
  });
  try {
    const samples = await repeatAsync(async () => {
      const start = performance.now();
      await proxy.ask();
      return performance.now() - start;
    }, ROUNDTRIP);
    return [duration("broadcast.roundtrip", null, "follower asks, leader answers immediately, same page", samples)];
  } finally {
    proxy.close();
  }
}

/** The whole follower path: channel, leader, worker, a real commit, and all the way back. */
async function broadcastFull(worker: BenchWorker, size: number): Promise<readonly CaseRow[]> {
  // A failure inside the leader cannot reject the follower's promise, so it is kept here and
  // raised once the loop is over rather than silently producing the timing of a no-op.
  let stumbled: unknown;
  const proxy = openProxy((request, reply) => {
    void worker.send({ type: "edit", size }).then(
      () => reply(request),
      (error: unknown) => {
        stumbled ??= error;
        reply(request);
      },
    );
  });
  try {
    const samples = await repeatAsync(async () => {
      const start = performance.now();
      await proxy.ask();
      return performance.now() - start;
    }, WIDE_ROUNDTRIP);
    if (stumbled !== undefined) throw new Error(messageOf(stumbled));
    return [
      duration(
        "broadcast.full",
        size,
        "follower → BroadcastChannel → leader → worker → sqlite update and commit → back the same way",
        samples,
      ),
    ];
  } finally {
    proxy.close();
  }
}

interface Proxy {
  ask(): Promise<void>;
  close(): void;
}

/**
 * Two channels on one name, in one page: a follower that asks and a leader that answers. A channel
 * never receives what it posted itself, so the two objects see only each other and the pairing is
 * the one a second tab would have — minus the process boundary, which makes this the optimistic
 * end of what the proxy costs.
 */
function openProxy(onRequest: (id: number, reply: (id: number) => void) => void): Proxy {
  const name = `weftdb-bench/${crypto.randomUUID()}`;
  const leader = new BroadcastChannel(name);
  const follower = new BroadcastChannel(name);
  const pending = new Map<number, () => void>();
  let next = 1;

  leader.addEventListener("message", (event: MessageEvent<{ readonly kind: string; readonly id: number }>) => {
    if (event.data.kind !== "request") return;
    onRequest(event.data.id, (id) => leader.postMessage({ kind: "response", id }));
  });
  follower.addEventListener("message", (event: MessageEvent<{ readonly kind: string; readonly id: number }>) => {
    if (event.data.kind !== "response") return;
    const settle = pending.get(event.data.id);
    if (settle === undefined) return;
    pending.delete(event.data.id);
    settle();
  });

  return {
    ask: () => {
      const id = next;
      next += 1;
      return new Promise<void>((resolve) => {
        pending.set(id, resolve);
        follower.postMessage({ kind: "request", id });
      });
    },
    close: () => {
      leader.close();
      follower.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The run.

async function runAll(): Promise<void> {
  runButton.disabled = true;
  copyButton.disabled = true;
  results.length = 0;
  resultsBody.replaceChildren();
  environmentList.replaceChildren();

  describeEnvironment("userAgent", navigator.userAgent);
  describeEnvironment("hardwareConcurrency", String(navigator.hardwareConcurrency));
  describeEnvironment("crossOriginIsolated", String(crossOriginIsolated));

  const worker = new BenchWorker(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
  let opfs = false;
  try {
    status("Booting the worker and installing the OPFS pool…");
    const init = (await worker.send({ type: "init" })) as InitValue;
    opfs = init.opfs;
    describeEnvironment(
      "OPFS sync access handle pool",
      init.opfs ? `available — ${init.detail}` : `UNAVAILABLE — ${init.detail}`,
    );
  } catch (error) {
    describeEnvironment("OPFS sync access handle pool", `UNAVAILABLE — ${messageOf(error)}`);
  }

  try {
    status("Measuring worker round trips…");
    await attempt("worker.roundtrip.empty", null, () => roundtripEmpty(worker));
    await attempt("worker.roundtrip.delta.1", null, () => roundtripDelta(worker, 1, ROUNDTRIP));
    await attempt("worker.roundtrip.delta.100", null, () => roundtripDelta(worker, 100, WIDE_ROUNDTRIP));

    for (const size of SIZES) {
      if (!opfs) {
        publish(failure("sqlite.commit", size, "no OPFS sync access handle pool in this browser"));
        publish(failure("sqlite.hydrate", size, "no OPFS sync access handle pool in this browser"));
        continue;
      }
      status(`Seeding a ${size.toLocaleString("en-US")}-row database in the worker…`);
      await yieldToPage();
      try {
        await worker.send({ type: "prepare", size });
      } catch (error) {
        publish(failure("sqlite.commit", size, messageOf(error)));
        publish(failure("sqlite.hydrate", size, messageOf(error)));
        continue;
      }
      status(`Committing single edits against ${size.toLocaleString("en-US")} rows…`);
      await attempt("sqlite.commit", size, () => commitCase(worker, size));
      status(`Hydrating ${size.toLocaleString("en-US")} rows…`);
      await attempt("sqlite.hydrate", size, () => hydrateCase(worker, size));
    }

    status("Bursting twenty edits at the worker…");
    if (opfs) await attempt(`echo.burst${BURST}`, INTERACTIVE, () => burstCase(worker, INTERACTIVE));
    else publish(failure(`echo.burst${BURST}`, INTERACTIVE, "no OPFS sync access handle pool in this browser"));

    status("Measuring the BroadcastChannel proxy…");
    await attempt("broadcast.roundtrip", null, () => broadcastRoundtrip());

    status("Measuring the whole follower path…");
    if (opfs) await attempt("broadcast.full", INTERACTIVE, () => broadcastFull(worker, INTERACTIVE));
    else publish(failure("broadcast.full", INTERACTIVE, "no OPFS sync access handle pool in this browser"));
  } finally {
    try {
      await worker.send({ type: "dispose" });
    } catch {
      // A worker that has already died has nothing left to clean up.
    }
    worker.terminate();
  }

  status(`Done. ${results.filter((row) => row.status === "ok").length} of ${results.length} cases produced numbers.`);
  copyButton.disabled = false;
  runButton.disabled = false;
  // Also on the console, because a clipboard write is the one part of this that a browser is
  // entitled to refuse.
  console.log("weftdb browser bench results", JSON.stringify({ environment, cases: results }, null, 2));
}

function asMarkdown(): string {
  const lines = [
    "### weftdb browser bench",
    "",
    ...Object.entries(environment).map(([key, value]) => `- **${key}**: ${value}`),
    "",
    "| case | rows | median ms | p95 ms | samples | note |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...results.map((row) =>
      [
        "",
        row.id,
        row.size === null ? "—" : row.size.toLocaleString("en-US"),
        row.median === null ? "—" : format(row.median),
        row.p95 === null ? "—" : format(row.p95),
        row.samples === 0 ? "—" : String(row.samples),
        row.note.replaceAll("|", "\\|"),
        "",
      ]
        .join(" | ")
        .trim(),
    ),
  ];
  return lines.join("\n");
}

runButton.addEventListener("click", () => {
  void runAll().catch((error: unknown) => {
    status(`The run stopped: ${messageOf(error)}`);
    runButton.disabled = false;
  });
});

copyButton.addEventListener("click", () => {
  const markdown = asMarkdown();
  console.log(markdown);
  void navigator.clipboard
    .writeText(markdown)
    .then(() => status("Results copied as Markdown."))
    .catch(() => status("The clipboard refused; the Markdown is on the console instead."));
});

status("Ready. Nothing has been measured yet.");
