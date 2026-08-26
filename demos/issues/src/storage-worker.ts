// This origin's database, and the sync session beside it. One `SharedWorker` serves every tab, and
// every tab's `openWeftDatabase` reaches it by constructing one at this module's URL.
import { serveDemoStorageWorker } from "weftdb-demo-shared/storage-worker";
import { demoSqlite } from "weftdb-demo-shared/sqlite";
import type { WeftWorkerScope } from "weftdb/client/worker-entry";
import { schema } from "./schema.ts";

const worker = serveDemoStorageWorker({ schema, sqlite: demoSqlite });

(globalThis as unknown as WeftWorkerScope).onconnect = (event) => {
  const port = event.ports[0];
  if (port !== undefined) worker.connect(port);
};
