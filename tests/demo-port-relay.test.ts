// The relay the docs demos sync against when there is no relay, a `WeftServer` in a
// `SharedWorker`, reached from each tab over a `MessagePort`.
//
// Both halves under test are the ones the demos ship, and only the process boundary is stood in
// for, since Node has no `SharedWorker` and each "tab" connects over a `MessageChannel` instead,
// exactly as a page connects over a shared worker's port. The clients are real `WeftClient`s
// running the real `syncWith`, so what these exercise is the sync path itself.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { test } from "vitest";
import { deviceId, fieldName, rowId, tableName, txnId, type WireValue } from "weftdb/core";
import { WeftClient, type ScopeAdvanced } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";
import { TODO_SCOPE as SCOPE } from "weftdb-demo-todo/scope";
import { RelayPortTransport, type RelayMessage, type RelayPortLike } from "../demos/shared/src/port-transport.ts";
import { serveDemoRelay, type WeftDemoRelay } from "../demos/shared/src/relay-worker.ts";
import { PortEndpoint, settle, waitFor } from "./multitab-fixtures.ts";

const TODOS = tableName("todos");
const TITLE = fieldName("title");
const HASH = schemaHash(schema);

test("two tabs of one browser converge through the relay running in it", async () => {
  using relay = new Relay();
  const alpha = client("alpha");
  const beta = client("beta");

  await newTodo(alpha, "todo-1", "buy milk");
  await alpha.syncWith(relay.connect(), HASH);
  await beta.syncWith(relay.connect(), HASH);

  assert.equal(beta.getRow(TODOS, rowId("todo-1"))?.fields.get(TITLE), "buy milk");
  assert.equal(alpha.outbox.length, 0, "acknowledged work stayed in the outbox");
  // Two ports, two devices, one scope. The tabs are as separate to the relay as a laptop and a
  // phone are, which is what makes their outboxes, clocks and cursors independent.
  assert.equal(relay.relay.connections, 2);
  assert.equal(relay.relay.server.devices.size, 2, "the two tabs were taken for one device");
});

test("a wake reaches the tab that did not push, and never the tab that did", async () => {
  using relay = new Relay();
  const woke: { alpha: ScopeAdvanced[]; beta: ScopeAdvanced[] } = { alpha: [], beta: [] };
  const alphaPort = relay.connect((advanced) => woke.alpha.push(advanced));
  const betaPort = relay.connect((advanced) => woke.beta.push(advanced));
  const alpha = client("alpha");
  const beta = client("beta");

  // Beta is connected and up to date, so the only thing that moves the scope is alpha's push.
  await beta.syncWith(betaPort, HASH);
  await newTodo(alpha, "todo-1", "buy milk");
  await alpha.syncWith(alphaPort, HASH);

  // The relay tells a second tab directly, so it updates without waiting for its next poll.
  await settle(() => woke.beta.length > 0);
  assert.equal(woke.beta[0]?.scopeId, SCOPE);
  assert.equal(woke.beta[0]?.serverSeq, relay.relay.server.scopes.get(SCOPE)?.serverSeq);
  // The push does not wake the pusher itself. A tab woken by its own push would sync again over
  // work it already has, and two tabs taking turns would keep each other syncing for as long as
  // the page was open.
  assert.deepEqual(woke.alpha, [], "the tab that pushed was woken by its own push");
});

test("a relay that throws rejects the caller rather than answering it wrongly", async () => {
  // A relay-side failure has no answer to give. Resolving with whatever is to hand would report a
  // broken relay as an empty scope, and an empty scope is a client's cue to drop rows.
  class Unreadable extends WeftServer {
    override pull(): never {
      throw new Error("the scope's records could not be read");
    }
  }
  using relay = new Relay(new Unreadable());
  const transport = relay.connect();

  await assert.rejects(transport.pull(SCOPE, 0), /the scope's records could not be read/u);
  // The port keeps serving after one call fails; a failed call does not close the connection.
  assert.equal((await transport.handshake(client("alpha").handshakeRequest(HASH))).ok, true);
});

test("a push the relay refuses is an answer, not a failure", async () => {
  using relay = new Relay();
  const transport = relay.connect();
  const alpha = client("alpha");
  await newTodo(alpha, "todo-1", "buy milk");
  const ops = [...alpha.outbox];

  assert.equal((await transport.push(SCOPE, ops)).ok, true);
  // The same create a second time. The row exists now, so the server refuses it. A rejection is
  // part of a `PushResult`, the value the client rebases and quarantines from, so it resolves.
  // Rejecting the promise would report diverged work as an unreachable relay, and the edit would
  // sit in the outbox instead of being surfaced.
  const again = await transport.push(SCOPE, ops);
  assert.equal(again.ok, false, "a refused push was reported as having succeeded");
  assert.equal(again.ok === false ? again.rejection.reason : undefined, "row_exists");
});

test("two calls in flight at once settle against their own answers", async () => {
  using relay = new Relay();
  const held = new HeldReplies(relay.channel());
  const transport = new RelayPortTransport({ port: held });

  // Both are outstanding before either is answered, which is the arrangement a session makes on
  // every reconnect and a page makes whenever a sync overlaps a snapshot.
  const pulled = transport.pull(SCOPE, 0);
  const shaken = transport.handshake(client("alpha").handshakeRequest(HASH));
  await waitFor(() => held.held.length === 2, "the relay did not answer both calls");
  held.deliverReversed();

  const batch = await pulled;
  const response = await shaken;
  assert.ok(Array.isArray(batch.rows), "the pull was settled with the handshake's answer");
  assert.equal(response.ok, true, "the handshake was settled with the pull's answer");
});

/** One relay, plus however many tabs a test connects to it. */
class Relay {
  readonly relay: WeftDemoRelay;
  readonly #channels: MessageChannel[] = [];
  readonly #transports: RelayPortTransport[] = [];

  constructor(server?: WeftServer) {
    this.relay = server === undefined ? serveDemoRelay() : serveDemoRelay(server);
  }

  /** One more tab's port, connected to the relay the way `onconnect` connects one. */
  channel(): RelayPortLike {
    const channel = new MessageChannel();
    this.#channels.push(channel);
    // A `node:worker_threads` port has every method `RelayPortLike` asks for. `PortEndpoint` only
    // supplies the two type declarations and starts the port.
    this.relay.connect(new PortEndpoint<RelayMessage>(channel.port2));
    return new PortEndpoint<RelayMessage>(channel.port1);
  }

  connect(onWake?: (advanced: ScopeAdvanced) => void): RelayPortTransport {
    const transport = new RelayPortTransport({
      port: this.channel(),
      ...(onWake === undefined ? {} : { onWake }),
    });
    this.#transports.push(transport);
    return transport;
  }

  [Symbol.dispose](): void {
    for (const transport of this.#transports) transport.close();
    this.relay.stop();
    // An open port keeps Node's event loop alive, so a failing run that skipped these would hang
    // the file with no failure ever reported.
    for (const channel of this.#channels) {
      channel.port1.close();
      channel.port2.close();
    }
  }
}

/**
 * A port that holds the relay's answers and then hands them over the other way round.
 *
 * A `MessagePort` delivers in the order things were posted, so the two answers arrive in the order
 * the two calls were made and a transport that settled the oldest waiting call would look right
 * every time. Reversing them is the only way to ask whether the correlation is really by id.
 */
class HeldReplies implements RelayPortLike {
  readonly held: RelayMessage[] = [];
  readonly #inner: RelayPortLike;
  readonly #listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(inner: RelayPortLike) {
    this.#inner = inner;
    this.#inner.addEventListener("message", (event) => {
      this.held.push(event.data as RelayMessage);
    });
  }

  postMessage(message: RelayMessage): void {
    this.#inner.postMessage(message);
  }

  addEventListener(type: "message" | "close", listener: (event: MessageEvent<unknown>) => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(type: "message" | "close", listener: (event: MessageEvent<unknown>) => void): void {
    this.#listeners.delete(listener);
  }

  deliverReversed(): void {
    for (const message of [...this.held].reverse()) {
      for (const listener of this.#listeners) listener({ data: message } as unknown as MessageEvent<unknown>);
    }
    this.held.length = 0;
  }
}

function client(device: string): WeftClient {
  return new WeftClient(SCOPE, deviceId(device), schema);
}

async function newTodo(target: WeftClient, id: string, title: string, notes = ""): Promise<void> {
  const values: Record<string, WireValue> = {
    title,
    notes,
    done: false,
    rank: "a0",
    due_at: null,
    auto_delete_days: null,
  };
  await target.create(TODOS, rowId(id), values, txnId(`create-${id}`));
}
