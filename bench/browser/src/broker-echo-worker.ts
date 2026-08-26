// A dedicated worker standing in for the storage worker, doing the one thing the brokered design
// asks of it: accept a port that arrived from another document, and answer on it.
//
// No SQLite here on purpose. What is unverified in a browser is whether a `MessagePort` survives
// being transferred through a `SharedWorker` into a second document's worker and still works;
// opening a database would only add a way for the probe to fail for an unrelated reason.
interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
}

/** How many ports this worker is serving, which is how many documents reached it. */
let served = 0;

function serve(port: PortLike): void {
  served += 1;
  const mine = served;
  port.addEventListener("message", (event: MessageEvent<unknown>) => {
    const asked = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    port.postMessage(`port ${String(mine)} of ${String(served)} answering ${asked}`);
  });
  port.start?.();
}

(globalThis as unknown as WorkerScope).addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as { readonly weft?: string; readonly port?: PortLike } | null;
  if (message === null || message.weft !== "connect") return;
  // Browsers populate both `event.ports` and the message body; the body is what the shipped host
  // reads, so the probe reads it too rather than proving a path nothing uses.
  const port = message.port;
  if (port !== undefined) serve(port);
});
