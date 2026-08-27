// The relay worker's front door. The whole of what its `SharedWorker` script has to say.
//
// A module of its own because a `SharedWorker` is identified by its script URL. Every tab that
// constructs one from this URL gets the same worker, which is the entire reason the relay can be
// one server rather than one per tab. A blob URL would be a different URL per tab and therefore a
// different relay per tab, which is no relay at all.
//
// A demo ships it as its own module:
//
// ```ts title="src/relay-worker.ts"
// import "weftdb-demo-shared/relay-worker-entry";
// ```
//
// and reaches it with `new SharedWorker(new URL("./relay-worker.ts", import.meta.url), { type: "module" })`.
import { serveDemoRelay } from "./relay-worker.ts";
import type { RelayPortLike } from "./port-transport.ts";

/** `SharedWorkerGlobalScope`, named here because this workspace typechecks without the worker library. */
interface SharedScope {
  onconnect: ((event: { readonly ports: readonly RelayPortLike[] }) => void) | null;
}

const relay = serveDemoRelay();

(globalThis as unknown as SharedScope).onconnect = (event) => {
  const port = event.ports[0];
  if (port !== undefined) relay.connect(port);
};

export { relay };
