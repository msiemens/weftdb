// The question this file exists to answer: can a `SharedWorker` hold an OPFS synchronous access
// handle, and can two tabs reach one database through it?
//
// If it can, the arbitration weftdb does by hand — a Web Lock election, a second `SharedWorker`
// brokering a `MessagePort` from each tab into whichever one holds the database, a succession
// notice when that tab dies, and a reconnect in every other tab — is arbitration the browser is
// already willing to do. One worker for the origin, a port per tab, and none of those pieces has
// anything left to arbitrate.
//
// It is a probe rather than a benchmark: what matters is whether each step is possible, and which
// one fails where it is not.
//
// Measured, over https on localhost:
//
//   Safari 26.6   every step, including a value written through one port and read back through a
//                 second, and one worker reporting two connections.
//   Firefox 152   `Missing required OPFS APIs` inside the SharedWorker. A synchronous access
//                 handle is not reachable from `SharedWorkerGlobalScope` there.
//   Chrome 151    the same refusal, headless.
//
// Two engines of three refuse it, and they are the ones following the specification.
// `createSyncAccessHandle()` is defined as available in dedicated workers only, so Safari passing is
// Safari granting more than the standard asks for. That settles it against a SharedWorker rather
// than leaving it open: a browser holding to the specification needs the Web Lock election and the
// port broker regardless, so the SharedWorker path would be a second one to keep working, resting on
// latitude one engine happens to allow. The arbitration stays weftdb's.
//
// Re-run this if the specification changes. Do not re-run it hoping a browser will.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { openWebSqliteExecutor, type Sqlite3Module, type WasmSqliteExecutor } from "weftdb/client/wasm-sqlite";

/** What a connecting port asks for, and what it is told. */
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

/** The `onconnect` global, named because this file is typechecked with the DOM library. */
interface SharedScope {
  onconnect: ((event: { readonly ports: readonly MessagePortLike[] }) => void) | null;
}

interface MessagePortLike {
  postMessage(message: ProbeResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ProbeRequest>) => void): void;
  start(): void;
}

/** How many ports have connected, which is how many tabs this one worker is serving. */
let connections = 0;
let executor: WasmSqliteExecutor | undefined;
let openFailure: string | undefined;

async function open(): Promise<void> {
  if (executor !== undefined || openFailure !== undefined) return;
  try {
    const sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3Module;
    if (sqlite3.installOpfsSAHPoolVfs === undefined) {
      openFailure = "this build has no installOpfsSAHPoolVfs, so there is no synchronous OPFS at all";
      return;
    }
    executor = await openWebSqliteExecutor(sqlite3, { path: "shared-probe.sqlite3", poolName: "weft-shared-probe" });
    executor.run({
      sql: "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      parameters: [],
    });
  } catch (error) {
    // The interesting failure. A `SharedWorker` is a worker context, so the handle ought to be
    // available; a browser that refuses here is the reason the hand-rolled election has to stay.
    openFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

function answer(request: ProbeRequest): ProbeResponse {
  if (executor === undefined) {
    return { id: request.id, ok: false, detail: openFailure ?? "the database was never opened" };
  }
  switch (request.kind) {
    case "open":
      return { id: request.id, ok: true, detail: `opened, serving ${String(connections)} port(s)` };
    case "write":
      executor.run({
        sql: "INSERT OR REPLACE INTO probe (id, value) VALUES (1, ?)",
        parameters: [request.value ?? ""],
      });
      return { id: request.id, ok: true, detail: `wrote ${request.value ?? ""}` };
    case "read": {
      const row = executor.get<{ value: string }>({
        sql: "SELECT value FROM probe WHERE id = 1",
        parameters: [],
        decode: (record) => ({ value: String(record["value"]) }),
      });
      return { id: request.id, ok: true, detail: row === undefined ? "(nothing written yet)" : row.value };
    }
  }
}

(globalThis as unknown as SharedScope).onconnect = (event) => {
  const port = event.ports[0];
  if (port === undefined) return;
  connections += 1;
  port.addEventListener("message", (message: MessageEvent<ProbeRequest>) => {
    void open().then(() => {
      port.postMessage(answer(message.data));
    });
  });
  port.start();
};
