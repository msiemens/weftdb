// The broker's front door: the whole of what a `SharedWorker` script has to say.
//
// A subpath of its own, and a small one on purpose. `client/worker-entry.ts` is separate because it
// reaches for `./sqlite.ts` and pulls the codegen module in with it; this is separate for the
// opposite reason — it imports one file that imports nothing, and putting it in the same script as
// the storage worker would load SQLite, the WebAssembly module and the generated schema into a
// third global whose only job is to move a port between two documents.
//
// It also cannot share a URL with the storage worker even if the weight did not matter. A
// `SharedWorker` is identified by its script URL: two tabs that construct one from the same URL get
// the same worker, which is exactly the property the broker needs, and it is the only property it
// needs. Nothing else here is negotiable — a blob URL would be a different URL per tab and
// therefore a different broker per tab, which is no broker at all.
//
// An application ships this as its own module, the way it ships the storage worker:
//
// ```ts title="src/broker.ts"
// import "weftdb/client/broker-entry";
// ```
//
// and hands `openWeftDatabase` the URL: `broker: new URL("./broker.ts", import.meta.url)`.
import { serveWeftPortBroker, type BrokerPortLike } from "./broker.ts";

/** `SharedWorkerGlobalScope`, named because this package is typechecked without the DOM library. */
interface SharedScope {
  onconnect: ((event: { readonly ports: readonly BrokerPortLike[] }) => void) | null;
}

const broker = serveWeftPortBroker();

(globalThis as unknown as SharedScope).onconnect = (event) => {
  const port = event.ports[0];
  if (port !== undefined) broker.connect(port);
};

export { broker };
