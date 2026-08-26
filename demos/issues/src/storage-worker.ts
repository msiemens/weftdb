// This tab's database, and the sync session beside it. `openWeftDatabase` constructs one of these
// per tab and hands it the port to the relay running in this browser.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveDemoStorageWorker } from "weftdb-demo-shared/storage-worker";
import { schema } from "./schema.ts";

void serveDemoStorageWorker({ schema, sqlite3InitModule });
