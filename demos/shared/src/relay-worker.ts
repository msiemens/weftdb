// The relay, running in the visitor's own browser: one `WeftServer` in a `SharedWorker`, serving a
// port to each tab of the origin.
//
// It stands in for a deployment rather than for a transport. Every tab still runs the real client
// and the real sync session, this end still runs the real `WeftServer`, and the four calls between
// them are the four calls the specification is about. What is gone is the network and the machine
// at the other end of it, which is what a demo on a static docs page cannot have.
//
// Nothing here needs storage. `WeftServer` imports only from `weftdb/core`, takes no executor and
// keeps its records in maps, so there is no SQLite, no WebAssembly and no persistence — which is
// also why a `SharedWorker` is enough to hold it, where the *database* worker is a dedicated worker
// because Firefox refuses OPFS access handles in a shared one. The scope's history therefore lasts
// exactly as long as the worker: close every tab of the origin and the relay's copy is gone, while
// each tab keeps its own rows in its own storage. For two tabs open beside each other, which is the
// whole of what these demos demonstrate, that is the entire lifetime that matters.
//
// There is no authorisation here, and there must not be. A deployed relay derives the scope and the
// device from a token, and that is what keeps one visitor's rows away from another's. This relay
// has nobody to keep apart: every "device" it serves is a tab of one person's browser, opened by
// that person, reading data that never leaves their machine. So a tab names its own scope and its
// own device in every call, and is believed. Anything modelled on this file needs the scope taken
// out of the caller's hands before it is put in front of a second person.
//
// Split from the module that binds it to `onconnect` for the same reason the port broker is:
// `SharedWorker` does not exist under Node, so a relay reachable only by constructing one would be
// a relay no test ever ran. `connect` takes a port, so the tests connect ordinary `MessageChannel`
// ends to the real thing and what they exercise is what ships.
import { WeftServer } from "weftdb/server";
import { contentAddressSnapshot } from "weftdb/server/snapshot";
import { isRelayRequest, type RelayPortLike, type RelayRequest, type RelayResults } from "./port-transport.ts";

/** The relay as it runs inside the `SharedWorker`. */
export interface WeftDemoRelay {
  /** Serves one connected tab. Called once per `onconnect`. */
  connect(port: RelayPortLike): void;
  /** The state every connected tab is syncing against. */
  readonly server: WeftServer;
  /** How many tabs are being served, for a test to read. */
  readonly connections: number;
  stop(): void;
}

/**
 * Starts a relay over one server, which is made here unless a caller has one to hand.
 *
 * Every port is served alike: there is no leader, no provider and no succession, because unlike the
 * port broker this holds the state itself rather than moving a connection to whoever does. A tab
 * that goes takes its port with it and leaves nothing behind that another tab depends on.
 */
export function serveDemoRelay(server: WeftServer = new WeftServer()): WeftDemoRelay {
  const connections = new Map<RelayPortLike, (event: MessageEvent<unknown>) => void>();
  /**
   * The port whose call is being carried out, so the wake that call causes is not sent back to it.
   * A tab that heard its own push would sync again on the strength of work it already has, and two
   * tabs pushing in turn would keep each other syncing for as long as the page was open.
   */
  let calling: RelayPortLike | undefined;
  let serving = true;

  // Watching the server rather than the push that moved it is what makes a change nobody pushed
  // reach the tabs: a prune raising the tombstone floor advances the scope and no call carries it.
  const unwatch = server.watch((scopeId, serverSeq) => {
    // To every other connection rather than to the ones known to care: the relay keeps no register
    // of which tab is on which scope, the notice names the scope it is about, and a tab drops what
    // is not its own. The alternative is a second register, built from the same calls, to be wrong.
    for (const port of connections.keys()) {
      if (port === calling) continue;
      port.postMessage({ weft: "relay", type: "advanced", scopeId, serverSeq });
    }
  });

  const onMessage = (port: RelayPortLike, event: MessageEvent<unknown>): void => {
    if (!serving) return;
    const request = event.data;
    if (!isRelayRequest(request)) return;
    calling = port;
    try {
      port.postMessage({ weft: "relay", id: request.id, ok: true, result: perform(server, request) });
    } catch (error) {
      // A throw is the relay failing to answer, and it goes back as a failure so the caller's
      // promise rejects. A push the server *refuses* never arrives here: a rejection is part of a
      // `PushResult`, returned rather than thrown, and travels as an ordinary answer.
      port.postMessage({
        weft: "relay",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      calling = undefined;
    }
  };

  return {
    server,
    get connections() {
      return connections.size;
    },
    connect: (port) => {
      if (!serving) return;
      const listener = (event: MessageEvent<unknown>): void => {
        onMessage(port, event);
      };
      connections.set(port, listener);
      port.addEventListener("message", listener);
      // A browser's `MessagePort` delivers nothing until it is started, and `addEventListener` does
      // not start one; Node's start themselves on the first listener, so a tab left unstarted here
      // would be a tab whose every call was answered into a queue nobody reads.
      port.start?.();
    },
    stop: () => {
      serving = false;
      unwatch();
      for (const [port, listener] of connections) port.removeEventListener("message", listener);
      connections.clear();
    },
  };
}

/** One call, carried out. The whole of what this relay does with what a tab sends it. */
function perform(server: WeftServer, request: RelayRequest): RelayResults[keyof RelayResults] {
  switch (request.op) {
    case "handshake":
      return server.handshake(request.argument);
    case "push":
      return server.push(request.argument.scopeId, [...request.argument.ops]);
    case "pull":
      return server.pull(request.argument.scopeId, request.argument.lastServerSeq);
    case "snapshot": {
      // The envelope only. The records are already in the body, and sending both would double the
      // largest message this relay produces — and the digest is what the receiving tab checks the
      // body against, which is the one thing worth carrying twice.
      const { snapshot: _snapshot, ...envelope } = contentAddressSnapshot(server.snapshot(request.argument.scopeId));
      return envelope;
    }
  }
}
