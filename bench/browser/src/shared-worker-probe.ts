// Two ports to one `SharedWorker`, which is what two tabs would have. The decisive result is the
// last one: a row written through the first port and read back through the second means one
// database served two connections, with no election, no channel and no proxy between them.
interface ProbeRequest {
  readonly id: number;
  readonly kind: "open" | "write" | "read";
  readonly value?: string;
}

interface ProbeResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly detail: string;
}

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const output = document.querySelector<HTMLElement>("#results");
const run = document.querySelector<HTMLButtonElement>("#run");

function render(steps: readonly Step[]): void {
  if (output === null) return;
  const rows = steps
    .map((step) => `| ${step.name} | ${step.ok ? "yes" : "no"} | ${step.detail.replace(/\|/gu, "\\|")} |`)
    .join("\n");
  output.textContent = ["| step | ok | detail |", "| --- | --- | --- |", rows].join("\n");
}

/** One request, correlated, with a deadline: an unsupported worker answers nothing at all. */
function ask(port: MessagePort, request: ProbeRequest, timeoutMs = 15_000): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${String(timeoutMs)}ms`)), timeoutMs);
    const listener = (event: MessageEvent<ProbeResponse>): void => {
      if (event.data.id !== request.id) return;
      clearTimeout(timer);
      port.removeEventListener("message", listener);
      resolve(event.data);
    };
    port.addEventListener("message", listener);
    port.postMessage(request);
  });
}

function connect(): MessagePort {
  const worker = new SharedWorker(new URL("./shared-worker-host.ts", import.meta.url), { type: "module" });
  worker.port.start();
  return worker.port;
}

async function probe(): Promise<void> {
  const steps: Step[] = [];
  const note = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
    render(steps);
  };

  note("userAgent", true, navigator.userAgent);
  note("crossOriginIsolated", crossOriginIsolated, String(crossOriginIsolated));

  if (typeof SharedWorker === "undefined") {
    note("SharedWorker constructible", false, "this browser has no SharedWorker, so the question stops here");
    return;
  }
  note("SharedWorker constructible", true, "present");

  let first: MessagePort;
  try {
    first = connect();
  } catch (error) {
    note("SharedWorker starts", false, error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    const opened = await ask(first, { id: 1, kind: "open" });
    // The one that decides it. A SharedWorker is a worker context, so a synchronous access handle
    // ought to be available; a browser that refuses here cannot hold the database this way.
    note("OPFS sync access handle inside it", opened.ok, opened.detail);
    if (!opened.ok) return;

    const written = await ask(first, { id: 2, kind: "write", value: `written-${String(Date.now())}` });
    note("write through the first port", written.ok, written.detail);

    // A second port is what a second tab holds. Same URL, same origin, so the browser hands back a
    // port to the worker that is already running rather than starting another.
    const second = connect();
    const readBack = await ask(second, { id: 3, kind: "read" });
    note(
      "second port reads the first port's write",
      readBack.ok && readBack.detail === written.detail.replace("wrote ", ""),
      readBack.detail,
    );
    const serving = await ask(second, { id: 4, kind: "open" });
    note("one worker serving both", serving.ok, serving.detail);
  } catch (error) {
    note("probe", false, error instanceof Error ? error.message : String(error));
  }
}

run?.addEventListener("click", () => {
  run.disabled = true;
  void probe().finally(() => {
    run.disabled = false;
  });
});
