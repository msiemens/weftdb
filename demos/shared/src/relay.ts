// The relay every demo talks to: the real server, persisting to SQLite, with the one concession
// that any tab may name itself.
//
// One process for all of them. The server is schema-blind, so a todo list and a chat need no more
// from it than each other does, and scope equality already keeps them apart. That also means one
// port, one proxy entry in the docs site, and one command to remember.
import { startRelay } from "weftdb/server/serve";
import { demoVerifier } from "./auth.ts";

export const DEFAULT_RELAY_PORT = 8787;

export interface DemoRelay {
  readonly url: string;
  close: () => Promise<void>;
}

export function relayPort(): number {
  return Number(process.env["WEFT_DEMO_RELAY_PORT"] ?? DEFAULT_RELAY_PORT);
}

export async function startDemoRelay(): Promise<DemoRelay> {
  return startRelay({
    host: "127.0.0.1",
    port: relayPort(),
    databasePath: process.env["WEFT_DEMO_DB"] ?? "demo.sqlite",
    tokens: new Map(),
    verifier: demoVerifier,
  });
}
