// The wake-up socket, checked at both levels: the framing on its own, and then the whole thing
// end to end against Node's built-in WebSocket client — which is the same implementation a
// browser would use, so a handshake or framing mistake shows up here rather than in a tab.
import assert from "node:assert/strict";
import { test } from "vitest";
import { connect, type Socket } from "node:net";
import fc from "fast-check";
import { deviceId, scopeId, fieldName, rowId, tableName, txnId, type FieldName, type WireValue } from "weftdb/shared";
import {
  connectSocketTransport,
  connectWakeups,
  httpTransport,
  WeftClient,
  type ScopeAdvanced,
  type SocketTransport,
} from "weftdb/client";
import { startRelay } from "weftdb/server/serve";
import { authContext } from "weftdb/server/relay";
import {
  CLOSE,
  decodeFrame,
  encodeClose,
  encodeFrame,
  encodeText,
  MAX_PAYLOAD_BYTES,
  OPCODE,
} from "weftdb/server/websocket-frames";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";

const SCOPE = scopeId("shared-list");
const TODOS = tableName("todos");
const HASH = schemaHash(schema);

function values(input: Record<string, WireValue>): Record<FieldName, WireValue> {
  return input;
}

/** A client frame, as a browser would put it on the wire: masked, with a random key. */
function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = (masked[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  const header: number[] = [(fin ? 0x80 : 0) | opcode];
  if (masked.length < 126) header.push(0x80 | masked.length);
  else if (masked.length < 65_536) header.push(0x80 | 126, (masked.length >> 8) & 0xff, masked.length & 0xff);
  else {
    header.push(0x80 | 127);
    for (let shift = 56n; shift >= 0n; shift -= 8n) header.push(Number((BigInt(masked.length) >> shift) & 0xffn));
  }
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

test("a frame survives the trip through the codec whatever its size", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 300 }), fc.constantFrom(OPCODE.text, OPCODE.binary), (bytes, opcode) => {
      const payload = Buffer.from(bytes);
      const read = decodeFrame(maskedFrame(opcode, payload), true);
      assert.equal(read.status, "frame");
      if (read.status !== "frame") return;
      assert.equal(read.frame.opcode, opcode);
      assert.deepEqual([...read.frame.payload], [...payload], "unmasking changed the bytes");
      assert.equal(read.rest.length, 0);
    }),
    { numRuns: 500 },
  );
});

test("the three payload length encodings all decode to the same thing", () => {
  // 125/126 and 65535/65536 are where the length stops fitting in the previous field, which is
  // exactly where an off-by-one turns the next frame's bytes into this frame's payload.
  for (const length of [0, 1, 125, 126, 127, 65_535, 65_536]) {
    const payload = Buffer.alloc(length, 0x61);
    const read = decodeFrame(maskedFrame(OPCODE.text, payload), true);
    assert.equal(read.status, "frame", `length ${length} did not decode`);
    if (read.status !== "frame") continue;
    assert.equal(read.frame.payload.length, length, `length ${length} decoded to the wrong size`);
  }
});

test("frames arriving in pieces are held until they are whole, and extras are kept", () => {
  const first = maskedFrame(OPCODE.text, Buffer.from("wake up", "utf8"));
  const second = maskedFrame(OPCODE.text, Buffer.from("again", "utf8"));
  const stream = Buffer.concat([first, second]);

  for (let split = 1; split < first.length; split += 1) {
    assert.equal(decodeFrame(stream.subarray(0, split), true).status, "partial", `split at ${split} was not partial`);
  }
  const read = decodeFrame(stream, true);
  assert.equal(read.status, "frame");
  if (read.status !== "frame") return;
  assert.equal(read.frame.payload.toString("utf8"), "wake up");
  // The second frame must still be there: dropping it loses a wake-up nobody will resend.
  assert.deepEqual([...read.rest], [...second], "the bytes after the frame were discarded");
});

test("frames the protocol forbids are refused rather than guessed at", () => {
  const unmasked = encodeText("from a client");
  assert.equal(decodeFrame(unmasked, true).status, "invalid", "an unmasked client frame was accepted");
  assert.equal(decodeFrame(unmasked, false).status, "frame", "a server frame must not be masked");

  const reserved = Buffer.from(maskedFrame(OPCODE.text, Buffer.from("x")));
  reserved[0] = (reserved[0] ?? 0) | 0x40;
  assert.equal(decodeFrame(reserved, true).status, "invalid", "a reserved bit was ignored");

  const unknownOpcode = maskedFrame(0x3, Buffer.from("x"));
  assert.equal(decodeFrame(unknownOpcode, true).status, "invalid");

  // A control frame is short and never fragmented; both rules exist so a peer cannot make the
  // server buffer indefinitely on something that is supposed to be answered immediately.
  const fragmentedPing = maskedFrame(OPCODE.ping, Buffer.from("x"));
  fragmentedPing[0] = OPCODE.ping;
  assert.equal(decodeFrame(fragmentedPing, true).status, "invalid");
  assert.equal(decodeFrame(maskedFrame(OPCODE.ping, Buffer.alloc(126)), true).status, "invalid");
});

test("an absurd declared length is refused before anything is allocated", () => {
  const header = Buffer.alloc(10);
  header[0] = 0x80 | OPCODE.text;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(MAX_PAYLOAD_BYTES) + 1n, 2);
  const read = decodeFrame(header, true);
  assert.equal(read.status, "invalid");
  if (read.status === "invalid") assert.match(read.reason, /too large/u);
});

test("a close frame carries its status where a peer expects it", () => {
  const read = decodeFrame(encodeClose(CLOSE.protocolError, "nope"), false);
  assert.equal(read.status, "frame");
  if (read.status !== "frame") return;
  assert.equal(read.frame.opcode, OPCODE.close);
  assert.equal(read.frame.payload.readUInt16BE(0), CLOSE.protocolError);
  assert.equal(read.frame.payload.subarray(2).toString("utf8"), "nope");
});

test("the encoder will not build a frame the decoder would refuse", () => {
  // The limit is the same in both directions, so a server can never emit something a
  // conforming peer has to close the connection over.
  const atLimit = Buffer.alloc(MAX_PAYLOAD_BYTES, 0x62);
  const read = decodeFrame(encodeFrame(OPCODE.binary, atLimit), false);
  assert.equal(read.status, "frame");
  if (read.status === "frame") assert.equal(read.frame.payload.length, MAX_PAYLOAD_BYTES);

  assert.throws(() => encodeFrame(OPCODE.binary, Buffer.alloc(MAX_PAYLOAD_BYTES + 1)), RangeError);
});

// --- end to end ---------------------------------------------------------------------------

interface Running {
  readonly url: string;
  readonly socketUrl: string;
  close(): Promise<void>;
  readonly relay: Awaited<ReturnType<typeof startRelay>>;
}

async function relay(): Promise<Running> {
  const running = await startRelay({
    host: "127.0.0.1",
    port: 0,
    tokens: new Map([
      ["token-alpha", authContext("shared-list", "alpha")],
      ["token-beta", authContext("shared-list", "beta")],
      ["token-elsewhere", authContext("someone-elses-list", "gamma")],
    ]),
  });
  return {
    url: running.url,
    socketUrl: `${running.url.replace(/^http/u, "ws")}/sync`,
    relay: running,
    close: () => running.close(),
  };
}

function client(device: string): WeftClient {
  return new WeftClient(SCOPE, deviceId(device), schema);
}

/** Resolves on the next wake-up, so a test never sleeps waiting for one. */
function nextWake(): {
  readonly promise: Promise<ScopeAdvanced | undefined>;
  readonly wake: (advanced: ScopeAdvanced | undefined) => void;
} {
  let wake: (advanced: ScopeAdvanced | undefined) => void = () => undefined;
  const promise = new Promise<ScopeAdvanced | undefined>((resolve) => {
    wake = resolve;
  });
  return { promise, wake };
}

test("a push by one device wakes another, which then pulls it", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());

  const wakes: (ScopeAdvanced | undefined)[] = [];
  const connected = nextWake();
  let pending = nextWake();
  const connection = connectWakeups({
    url: running.socketUrl,
    token: "token-beta",
    onWake: (advanced) => {
      wakes.push(advanced);
      if (advanced === undefined) connected.wake(undefined);
      else pending.wake(advanced);
    },
  });
  t.onTestFinished(() => connection.close());
  await connected.promise;
  assert.equal(connection.connected, true, "the socket never reported itself connected");

  // Alpha writes over HTTP, exactly as it would with no socket in the picture.
  const alpha = client("alpha");
  alpha.create(
    TODOS,
    rowId("todo-1"),
    values({ title: "buy milk", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await alpha.syncWith(httpTransport({ baseUrl: running.url, token: "token-alpha" }), HASH);

  const advanced = await pending.promise;
  assert.equal(advanced?.type, "advanced");
  assert.equal(advanced?.scopeId, SCOPE);
  assert.ok((advanced?.serverSeq ?? 0) > 0, "the wake-up carried no sequence to catch up to");

  // The wake-up carries no data — beta learns what changed the ordinary way.
  const beta = client("beta");
  await beta.syncWith(httpTransport({ baseUrl: running.url, token: "token-beta" }), HASH);
  assert.equal(beta.getRow(TODOS, rowId("todo-1"))?.fields.get(fieldName("title")), "buy milk");

  // Beta's own sync must not wake beta again in a loop.
  pending = nextWake();
  const quiet = await Promise.race([
    pending.promise.then(() => "woken" as const),
    new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), 250)),
  ]);
  assert.equal(quiet, "quiet", "an empty push woke everybody for nothing");
});

test("a change nobody pushed still wakes the devices it affects", async (t) => {
  // Pruning raises the tombstone floor, which is exactly the change a device most needs to
  // hear about — below the floor it can no longer be caught up incrementally at all. Nothing
  // was pushed, so a relay that only broadcasts from its push route says nothing.
  const running = await relay();
  t.onTestFinished(() => running.close());

  const connected = nextWake();
  const pending = nextWake();
  const connection = connectWakeups({
    url: running.socketUrl,
    token: "token-beta",
    onWake: (advanced) => (advanced === undefined ? connected.wake(undefined) : pending.wake(advanced)),
  });
  t.onTestFinished(() => connection.close());
  await connected.promise;

  // Something to prune: a row deleted long enough ago to be past the retention window.
  const alpha = client("alpha");
  alpha.create(
    TODOS,
    rowId("todo-1"),
    values({ title: "temporary", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  alpha.delete(TODOS, rowId("todo-1"), txnId("delete"));
  await alpha.syncWith(httpTransport({ baseUrl: running.url, token: "token-alpha" }), HASH);
  await pending.promise;

  const afterPush = nextWake();
  const listener = connectWakeups({
    url: running.socketUrl,
    token: "token-alpha",
    onWake: (advanced) => {
      if (advanced !== undefined) afterPush.wake(advanced);
    },
  });
  t.onTestFinished(() => listener.close());
  await new Promise((resolve) => setTimeout(resolve, 100));

  // No client asked for this; a maintenance job did.
  assert.equal(running.relay.server.pruneTombstones(SCOPE, 0), 1, "nothing was pruned, so this proves nothing");
  const advanced = await afterPush.promise;
  assert.equal(advanced?.scopeId, SCOPE, "the prune went unannounced");
});

test("a socket that stops answering is dropped rather than kept forever", async (t) => {
  const running = await startRelay({
    host: "127.0.0.1",
    port: 0,
    tokens: new Map([["token-beta", authContext("shared-list", "beta")]]),
    // Driven by hand below rather than by waiting for a real interval.
    keepaliveMs: 0,
  });
  t.onTestFinished(() => running.close());
  const socketUrl = `${running.url.replace(/^http/u, "ws")}/sync`;

  const socket = new WebSocket(socketUrl, ["weft.v1", "weft.token.token-beta"]);
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  assert.equal(running.sockets.subscribers(SCOPE), 1);

  // A live peer answers the ping, so the second sweep still finds it there.
  running.sockets.sweep();
  await new Promise((resolve) => setTimeout(resolve, 100));
  running.sockets.sweep();
  assert.equal(running.sockets.subscribers(SCOPE), 1, "a healthy connection was dropped");

  // A peer that has gone away without saying so answers nothing, and is gone by the sweep
  // after the one it failed to answer.
  const silent = new WebSocket(socketUrl, ["weft.v1", "weft.token.token-beta"]);
  await new Promise<void>((resolve) => silent.addEventListener("open", () => resolve()));
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(running.sockets.subscribers(SCOPE), 1);

  // Node's client answers pings automatically, so "silent" is simulated by sweeping twice
  // with no chance for the pong to arrive in between.
  running.sockets.sweep();
  running.sockets.sweep();
  assert.equal(running.sockets.subscribers(SCOPE), 0, "a connection that answered nothing was kept");
});

test("a wake-up never reaches a scope the token does not name", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());

  const woken: (ScopeAdvanced | undefined)[] = [];
  const connected = nextWake();
  const connection = connectWakeups({
    url: running.socketUrl,
    token: "token-elsewhere",
    onWake: (advanced) => {
      woken.push(advanced);
      if (advanced === undefined) connected.wake(undefined);
    },
  });
  t.onTestFinished(() => connection.close());
  await connected.promise;

  const alpha = client("alpha");
  alpha.create(
    TODOS,
    rowId("todo-1"),
    values({ title: "private", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await alpha.syncWith(httpTransport({ baseUrl: running.url, token: "token-alpha" }), HASH);
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.deepEqual(woken, [undefined], "a listener was told about a scope its token does not name");
});

test("a socket without a valid token is refused", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());

  const closed = new Promise<void>((resolve) => {
    const socket = new WebSocket(running.socketUrl, ["weft.v1", "weft.token.not-a-token"]);
    socket.addEventListener("close", () => resolve());
    socket.addEventListener("error", () => resolve());
  });
  await closed;
  assert.equal(running.relay.sockets.subscribers(SCOPE), 0, "an unauthenticated socket was registered");
});

test("a dropped socket comes back and asks for a catch-up", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());

  let connects = 0;
  const reconnected = nextWake();
  const connection = connectWakeups({
    url: running.socketUrl,
    token: "token-beta",
    onWake: (advanced) => {
      if (advanced !== undefined) return;
      connects += 1;
      // A socket that has just come up cannot know what it missed, so it syncs once.
      if (connects === 2) reconnected.wake(undefined);
    },
  });
  t.onTestFinished(() => connection.close());

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(running.relay.sockets.subscribers(SCOPE), 1);

  // The relay drops everyone, as it would on a restart or a deployment.
  running.relay.sockets.close();
  await reconnected.promise;
  assert.equal(connects, 2, "the connection did not come back");
});

test("a change in one tab reaches another with nobody polling for it", async (t) => {
  // The demo's fallback timer is a minute apart when the socket is up, so anything that
  // arrives inside a second or two arrived because the relay said so.
  const { TodoStore } = await import("weftdb-demo-todo");
  const running = await relay();
  t.onTestFinished(() => running.close());

  const open = (device: string, token: string): InstanceType<typeof TodoStore> =>
    new TodoStore({
      identity: { scopeId: SCOPE, deviceId: deviceId(device), label: device, token },
      client: client(device),
      transport: httpTransport({ baseUrl: running.url, token }),
      socketUrl: running.socketUrl,
    });

  const writer = open("alpha", "token-alpha");
  const reader = open("beta", "token-beta");
  t.onTestFinished(writer.start());
  t.onTestFinished(reader.start());

  // Both sockets up before anything is written, so the wake-up is the only way across.
  await waitFor(() => reader.status().live && writer.status().live, "the sockets never connected");

  writer.todos.create("todo-1", {
    title: "buy milk",
    notes: "",
    done: false,
    rank: "a0",
    due_at: null,
    auto_delete_days: null,
  });

  await waitFor(
    () => reader.rows().some((row) => row.title === "buy milk"),
    "the other tab never heard about the change",
  );
});

async function waitFor(condition: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

// --- the socket as the transport ------------------------------------------------------------

async function connected(running: Running, token: string): Promise<SocketTransport> {
  const transport = connectSocketTransport({ url: running.socketUrl, token });
  await waitFor(() => transport.connected, "the socket never connected");
  return transport;
}

test("a whole sync session runs over the socket", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());
  const alpha = await connected(running, "token-alpha");
  const beta = await connected(running, "token-beta");
  t.onTestFinished(() => {
    alpha.close();
    beta.close();
  });

  const writer = client("alpha");
  writer.create(
    TODOS,
    rowId("todo-1"),
    values({
      title: "buy milk",
      notes: "Monday: nothing",
      done: false,
      rank: "a0",
      due_at: null,
      auto_delete_days: null,
    }),
    txnId("create"),
  );
  await writer.syncWith(alpha, HASH);
  assert.equal(writer.outbox.length, 0, "the push never drained over the socket");

  const reader = client("beta");
  await reader.syncWith(beta, HASH);
  assert.equal(reader.getRow(TODOS, rowId("todo-1"))?.fields.get(fieldName("title")), "buy milk");
});

test("the socket transport ends where the HTTP one does", async (t) => {
  // The two carry the same four calls, so a history run over each has to land in the same
  // place. Anything else means the transport is doing something of its own.
  const running = await relay();
  t.onTestFinished(() => running.close());
  const socket = await connected(running, "token-alpha");
  t.onTestFinished(() => socket.close());

  const overSocket = client("alpha");
  const overHttp = client("beta");
  const http = httpTransport({ baseUrl: running.url, token: "token-beta" });

  for (const [target, transport, id] of [
    [overSocket, socket, "todo-socket"],
    [overHttp, http, "todo-http"],
  ] as const) {
    target.create(
      TODOS,
      rowId(id),
      values({
        title: "plan",
        notes: "Monday: nothing",
        done: false,
        rank: "a0",
        due_at: null,
        auto_delete_days: null,
      }),
      txnId(`create-${id}`),
    );
    await target.syncWith(transport, HASH);
    target.update(TODOS, rowId(id), values({ notes: "Monday: drafted" }), txnId(`edit-${id}`));
    await target.syncWith(transport, HASH);
    target.delete(TODOS, rowId(id), txnId(`delete-${id}`));
    await target.syncWith(transport, HASH);
  }

  // Both catch up on everything before being compared, so what is left is what the transports
  // did rather than what order the test happened to run them in.
  await overSocket.syncWith(socket, HASH);
  await overHttp.syncWith(http, HASH);
  await overSocket.syncWith(socket, HASH);

  assert.equal(overSocket.outbox.length, 0);
  assert.equal(overHttp.outbox.length, 0);
  assert.equal(overSocket.listQuarantine().length, overHttp.listQuarantine().length);
  assert.deepEqual(
    [...overSocket.tombstones.keys()].sort(),
    [...overHttp.tombstones.keys()].sort(),
    "the two transports disagree about what was deleted",
  );
  assert.deepEqual(
    [...overSocket.rows.keys()].sort(),
    [...overHttp.rows.keys()].sort(),
    "the two transports disagree about which rows exist",
  );
});

test("a rejection comes back over the socket as a rejection, not an error", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());
  const socket = await connected(running, "token-alpha");
  t.onTestFinished(() => socket.close());

  const alpha = client("alpha");
  alpha.create(
    TODOS,
    rowId("todo-1"),
    values({ title: "plan", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await alpha.syncWith(socket, HASH);

  // A second create for a row that exists is refused by the server, and the client has to see
  // that as a rejection it can act on rather than as the connection failing.
  const other = client("beta");
  other.create(
    TODOS,
    rowId("todo-1"),
    values({ title: "mine", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("clash"),
  );
  const beta = await connected(running, "token-beta");
  t.onTestFinished(() => beta.close());
  await other.syncWith(beta, HASH);

  const quarantined = other.listQuarantine();
  assert.ok(quarantined.length > 0, "the clashing transaction was not surfaced");
  assert.deepEqual(
    [...new Set(quarantined.map((op) => op.reason))],
    ["row_exists"],
    "the rejection did not survive the socket as a rejection",
  );
  assert.equal(other.outbox.length, 0, "quarantine is a move, not a copy");
});

test("a large answer does not hold up everything behind it", async (t) => {
  // One socket carries every request and every wake-up, so a megabyte written in one go is a
  // megabyte during which nothing else on that connection moves. Large answers go out in
  // pieces; this checks that something sent during one actually arrives in the middle of it
  // rather than after the whole thing.
  const running = await relay();
  t.onTestFinished(() => running.close());

  const writer = await connected(running, "token-alpha");
  t.onTestFinished(() => writer.close());
  const seed = client("alpha");
  seed.create(
    TODOS,
    rowId("todo-1"),
    values({
      title: "big",
      notes: "y".repeat(400_000),
      done: false,
      rank: "a0",
      due_at: null,
      auto_delete_days: null,
    }),
    txnId("create"),
  );
  await seed.syncWith(writer, HASH);

  // A raw socket, so the order messages arrive in is visible.
  const socket = new WebSocket(running.socketUrl, ["weft.v1", "weft.token.token-beta"]);
  const order: string[] = [];
  const sawWakeDuringSnapshot = new Promise<boolean>((resolve) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { readonly type?: string; readonly last?: boolean };
      order.push(message.type ?? "?");
      // A wake-up landing while chunks are still coming is the whole point.
      if (message.type === "advanced") resolve(order.filter((kind) => kind === "chunk").length > 0);
      if (message.type === "chunk" && message.last === true) resolve(false);
    });
  });

  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  socket.send(JSON.stringify({ id: "snapshot-1", op: "snapshot" }));
  // Something else happens while that answer is going out.
  seed.update(TODOS, rowId("todo-1"), values({ title: "changed" }), txnId("edit"));
  await seed.syncWith(writer, HASH);

  assert.equal(await sawWakeDuringSnapshot, true, "the wake-up queued behind the whole snapshot");
  assert.ok(order.filter((kind) => kind === "chunk").length > 1, "the large answer was not split at all");
  socket.close();
});

test("a request the relay cannot carry out is refused, and the connection carries on", async (t) => {
  // The socket names operations rather than routes, so the ways a request can be wrong are
  // "no such operation" and "that operation needs an argument you did not send". Neither may
  // take the connection down: everything else a device has in flight is on it.
  const running = await relay();
  t.onTestFinished(() => running.close());

  const socket = new WebSocket(running.socketUrl, ["weft.v1", "weft.token.token-alpha"]);
  const answers: { readonly type?: string; readonly id?: string; readonly reason?: string }[] = [];
  socket.addEventListener("message", (event) => {
    answers.push(JSON.parse(String(event.data)) as { readonly type?: string; readonly id?: string });
  });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));

  socket.send(JSON.stringify({ id: "unknown-1", op: "delete-everything" }));
  socket.send(JSON.stringify({ id: "malformed-1", op: "pull" }));
  socket.send(JSON.stringify({ id: "good-1", op: "pull", lastServerSeq: 0 }));
  await waitFor(() => answers.length >= 3, "the relay did not answer all three requests");

  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  assert.equal(byId.get("unknown-1")?.type, "failure", "an unknown operation was not refused");
  assert.match(String(byId.get("unknown-1")?.reason), /delete-everything/u);
  assert.equal(byId.get("malformed-1")?.type, "failure", "a pull with no cursor was not refused");
  assert.match(String(byId.get("malformed-1")?.reason), /lastServerSeq/u);
  assert.equal(byId.get("good-1")?.type, "response", "the connection stopped working after a refusal");
  socket.close();
});

test("a subscribed client is sent what changed, not a note saying something did", async (t) => {
  // The wake-up costs a round trip: the relay knows what moved, and telling a client to come
  // and ask for it is a second message carrying nothing. A client that says where its cursor
  // is gets the records instead — the same batch `/pull` would have answered with, applied by
  // the same code, so nothing about merging changes.
  const running = await relay();
  t.onTestFinished(() => running.close());

  const reader = client("beta");
  const batches: number[] = [];
  const transport = connectSocketTransport({
    url: running.socketUrl,
    token: "token-beta",
    cursor: () => reader.lastServerSeq,
    onBatch: (batch) => {
      batches.push(batch.fields.length);
      reader.applyPull(batch);
    },
  });
  t.onTestFinished(() => transport.close());
  await waitFor(() => transport.connected, "the socket never connected");

  const writer = client("alpha");
  writer.create(
    TODOS,
    rowId("todo-1"),
    values({ title: "buy milk", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await writer.syncWith(httpTransport({ baseUrl: running.url, token: "token-alpha" }), HASH);

  // No pull from this client at any point: everything it holds arrived unasked.
  await waitFor(
    () => reader.getRow(TODOS, rowId("todo-1"))?.fields.get(fieldName("title")) === "buy milk",
    "the change never arrived without being asked for",
  );
  assert.ok(
    batches.some((count) => count > 0),
    "a batch arrived carrying no records",
  );
});

test("a subscribed socket cannot advance itself with a non-finite cursor", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());

  const socket = new WebSocket(running.socketUrl, ["weft.v1", "weft.token.token-beta"]);
  const batches: Array<{ readonly fields?: readonly unknown[] }> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      readonly type?: string;
      readonly batch?: { readonly fields?: readonly unknown[] };
    };
    if (message.type === "batch") batches.push(message.batch ?? {});
  });
  t.onTestFinished(() => socket.close());
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));

  // `JSON.stringify(Infinity)` becomes null, but a peer is not obliged to use that encoder.
  socket.send('{"type":"subscribe","lastServerSeq":1e309}');

  const writer = client("alpha");
  writer.create(
    TODOS,
    rowId("todo-1"),
    values({ title: "must arrive", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await writer.syncWith(httpTransport({ baseUrl: running.url, token: "token-alpha" }), HASH);

  await waitFor(
    () => batches.some((batch) => (batch.fields?.length ?? 0) > 0),
    "a non-finite subscription cursor skipped records",
  );
});

test("a subscribed socket cannot advance itself with a future cursor", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());

  const socket = new WebSocket(running.socketUrl, ["weft.v1", "weft.token.token-beta"]);
  const batches: Array<{ readonly fields?: readonly unknown[] }> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      readonly type?: string;
      readonly batch?: { readonly fields?: readonly unknown[] };
    };
    if (message.type === "batch") batches.push(message.batch ?? {});
  });
  t.onTestFinished(() => socket.close());
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));

  socket.send(JSON.stringify({ type: "subscribe", lastServerSeq: 999_999 }));

  const writer = client("alpha");
  writer.create(
    TODOS,
    rowId("todo-future"),
    values({ title: "must arrive", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await writer.syncWith(httpTransport({ baseUrl: running.url, token: "token-alpha" }), HASH);

  await waitFor(
    () => batches.some((batch) => (batch.fields?.length ?? 0) > 0),
    "a future subscription cursor skipped records",
  );
});

test("a fragmented websocket request is answered or rejected instead of ignored", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());
  const socket = await rawWebSocket(running.socketUrl, "token-alpha");
  // A block body, not an expression one: `destroy()` answers with the socket, and a cleanup
  // callback is typed as returning nothing or a promise.
  t.onTestFinished(() => {
    socket.destroy();
  });

  const request = Buffer.from(JSON.stringify({ id: "fragmented", op: "pull", lastServerSeq: 0 }), "utf8");
  const split = Math.floor(request.length / 2);
  socket.write(maskedFrame(OPCODE.text, request.subarray(0, split), false));
  socket.write(maskedFrame(OPCODE.continuation, request.subarray(split)));

  const outcome = await Promise.race([
    readServerFrame(socket).then((frame) => (frame.opcode === OPCODE.close ? "closed" : "answered")),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
  ]);
  assert.notEqual(outcome, "timeout", "a fragmented request was neither answered nor rejected");
});

test("a subscribed client that reconnects is sent what it missed", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());

  const reader = client("beta");
  const transport = connectSocketTransport({
    url: running.socketUrl,
    token: "token-beta",
    cursor: () => reader.lastServerSeq,
    onBatch: (batch) => reader.applyPull(batch),
  });
  t.onTestFinished(() => transport.close());
  await waitFor(() => transport.connected, "the socket never connected");

  // The connection dies, and the change happens while it is down.
  running.relay.sockets.close();
  await waitFor(() => !transport.connected, "the socket did not notice it had been dropped");
  const writer = client("alpha");
  writer.create(
    TODOS,
    rowId("todo-2"),
    values({ title: "while away", notes: "", done: false, rank: "a0", due_at: null, auto_delete_days: null }),
    txnId("create"),
  );
  await writer.syncWith(httpTransport({ baseUrl: running.url, token: "token-alpha" }), HASH);

  // Re-subscribing says where this client actually got to, so what it missed comes back.
  await waitFor(
    () => reader.getRow(TODOS, rowId("todo-2"))?.fields.get(fieldName("title")) === "while away",
    "what changed while the socket was down never arrived",
  );
});

test("a socket the relay refuses does not become a transport", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());
  const transport = connectSocketTransport({ url: running.socketUrl, token: "not-a-token" });
  t.onTestFinished(() => transport.close());

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(transport.connected, false);
  // Failing loudly is the point: work stays in the outbox rather than looking as if it synced.
  await assert.rejects(transport.pull(SCOPE, 0), /not connected/u);
});

test("a request in flight when the socket drops fails rather than hanging", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());
  const transport = await connected(running, "token-alpha");
  t.onTestFinished(() => transport.close());

  const inFlight = transport.pull(SCOPE, 0);
  running.relay.sockets.close();
  await assert.rejects(inFlight, /socket/u, "a request outlived the connection it was made on");
});

test("closing the connection stops it reconnecting", async (t) => {
  const running = await relay();
  t.onTestFinished(() => running.close());

  const connected = nextWake();
  let wakes = 0;
  const connection = connectWakeups({
    url: running.socketUrl,
    token: "token-beta",
    onWake: (advanced) => {
      wakes += 1;
      if (advanced === undefined) connected.wake(undefined);
    },
  });
  await connected.promise;
  connection.close();

  running.relay.sockets.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(wakes, 1, "a closed connection kept waking its owner");
  assert.equal(connection.connected, false);
});

async function rawWebSocket(socketUrl: string, token: string): Promise<Socket> {
  const url = new URL(socketUrl);
  const socket = connect(Number(url.port), url.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const key = Buffer.from("weftdb-test-key!").toString("base64");
  socket.write(
    [
      `GET ${url.pathname} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Protocol: weft.v1, weft.token.${token}`,
      "",
      "",
    ].join("\r\n"),
  );
  await readUntil(socket, "\r\n\r\n");
  return socket;
}

async function readServerFrame(socket: Socket): Promise<import("weftdb/server/websocket-frames").Frame> {
  let buffer = Buffer.alloc(0);
  for (;;) {
    const chunk = await onceData(socket);
    buffer = Buffer.concat([buffer, chunk]);
    const decoded = decodeFrame(buffer, false);
    if (decoded.status === "frame") return decoded.frame;
    if (decoded.status === "invalid") throw new Error(decoded.reason);
  }
}

async function readUntil(socket: Socket, marker: string): Promise<string> {
  let buffered = "";
  while (!buffered.includes(marker)) {
    buffered += (await onceData(socket)).toString("utf8");
  }
  return buffered;
}

function onceData(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once("data", resolve);
    socket.once("error", reject);
  });
}
