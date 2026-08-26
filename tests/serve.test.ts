// The runnable relay: environment configuration and the Node HTTP adapter around the
// fetch-style handler.
import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { deviceId, encodeHlc, rowId, scopeId, tableName, txnId, type WeftOp } from "weftdb/core";
import {
  envFromArgv,
  MAX_BODY_BYTES,
  resolveTokenSource,
  serveOptionsFromEnv,
  startRelay,
  type RunningServer,
  type ServeOptions,
} from "weftdb/server/serve";
import { createHmac } from "node:crypto";

const tokenPartArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/u);

test("token configuration round-trips through the environment", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.tuple(tokenPartArb, tokenPartArb, tokenPartArb), {
        minLength: 1,
        maxLength: 5,
        selector: ([token]) => token,
      }),
      (entries) => {
        const config = serveOptionsFromEnv({
          WEFT_TOKENS: entries.map(([token, scope, device]) => `${token}:${scope}:${device}`).join(","),
        });
        assert.equal(config.ok, true, config.ok ? "" : config.errors.join());
        if (!config.ok) return;
        assert.equal(config.options.tokens.size, entries.length);
        for (const [token, scope, device] of entries) {
          assert.deepEqual(config.options.tokens.get(token), { scopeId: scopeId(scope), deviceId: device });
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("a flag says the same thing as its environment variable, and wins over it", () => {
  // Both surfaces exist for different reasons — an orchestrator sets the environment, a person
  // types a flag — so they have to mean the same thing, and the more specific one has to win.
  assert.deepEqual(envFromArgv(["--port", "9001", "--db", "/data/weft.sqlite"]), {
    WEFT_PORT: "9001",
    WEFT_DB: "/data/weft.sqlite",
  });
  assert.deepEqual(envFromArgv(["--port=9002"]), { WEFT_PORT: "9002" });

  const configured = { WEFT_PORT: "8787", WEFT_TOKENS: "t:s:d", ...envFromArgv(["--port", "9003"]) };
  const config = serveOptionsFromEnv(configured);
  assert.equal(config.ok, true);
  if (config.ok) assert.equal(config.options.port, 9003);

  // A flag with no value takes nothing from the flag that follows it.
  assert.deepEqual(envFromArgv(["--port", "--db", "/data/weft.sqlite"]), { WEFT_DB: "/data/weft.sqlite" });
  assert.deepEqual(envFromArgv(["--not-a-flag", "x"]), {});
});

test("a relay configured for JWTs verifies them, and refuses the ways of asking for less", () => {
  const secret = "a-shared-secret-that-is-long-enough";
  const config = serveOptionsFromEnv({
    ...envFromArgv(["--jwt-algorithms", "HS256", "--jwt-secret", secret, "--jwt-issuer", "https://issuer.example"]),
  });
  assert.equal(config.ok, true, "a JWT-configured relay would not start");
  if (!config.ok) return;

  const claims = {
    iss: "https://issuer.example",
    scope: "user-1",
    device: "laptop",
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const signed = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const token = `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
  assert.deepEqual(config.options.verifier?.verify(token), {
    scopeId: scopeId("user-1"),
    deviceId: deviceId("laptop"),
  });
  assert.equal(config.options.verifier?.verify(`${signed}.tampered`), undefined);

  for (const [name, env] of [
    ["a key with no algorithm", { WEFT_JWT_SECRET: secret }],
    ["an algorithm with no key", { WEFT_JWT_ALGORITHMS: "RS256" }],
    ["an algorithm this server cannot verify", { WEFT_JWT_ALGORITHMS: "none", WEFT_JWT_SECRET: secret }],
    ["an empty HMAC secret", { WEFT_JWT_ALGORITHMS: "HS256", WEFT_JWT_SECRET: "" }],
    ["a secret for a public-key algorithm", { WEFT_JWT_ALGORITHMS: "RS256", WEFT_JWT_SECRET: secret }],
    [
      "mixed symmetric and public-key algorithms with one key",
      { WEFT_JWT_ALGORITHMS: "HS256,RS256", WEFT_JWT_SECRET: secret },
    ],
    ["both ways of authenticating", { WEFT_JWT_ALGORITHMS: "HS256", WEFT_JWT_SECRET: secret, WEFT_TOKENS: "t:s:d" }],
  ] as const) {
    assert.equal(serveOptionsFromEnv(env).ok, false, `${name} was accepted`);
  }
});

test("a JWT key can come from a file, like every other secret", async () => {
  const resolved = await resolveTokenSource(
    { WEFT_JWT_PUBLIC_KEY_FILE: "/run/secrets/jwt.pem", WEFT_JWT_ALGORITHMS: "RS256" },
    async () => "-----BEGIN PUBLIC KEY-----\nnot-a-real-key\n-----END PUBLIC KEY-----\n",
  );
  assert.match(String(resolved["WEFT_JWT_PUBLIC_KEY"]), /BEGIN PUBLIC KEY/u);
});

test("a relay with no way to authenticate anyone refuses to start", () => {
  for (const env of [{}, { WEFT_TOKENS: "" }, { WEFT_TOKENS: "   " }, { WEFT_TOKENS: " , , " }]) {
    const config = serveOptionsFromEnv(env);
    assert.equal(config.ok, false, `${JSON.stringify(env)} was accepted`);
    assert.match(config.ok ? "" : config.errors.join(), /WEFT_TOKENS/u);
  }
});

test("tokens can come from a file so they need not sit in the environment", async () => {
  const source = await resolveTokenSource({ WEFT_TOKENS_FILE: "/run/secrets/weft-tokens" }, async (path) =>
    path === "/run/secrets/weft-tokens" ? "one:scope-1:device-1\ntwo:scope-2:device-2\n" : "",
  );
  const config = serveOptionsFromEnv(source);
  assert.equal(config.ok, true, config.ok ? "" : config.errors.join());
  assert.deepEqual(config.ok ? [...config.options.tokens.keys()] : [], ["one", "two"]);
});

test("an oversized body is refused before it is buffered", async (t) => {
  const relay = await listen(t);
  const response = await fetch(`${relay.url}/push`, {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
  assert.equal(response.status, 413);
  assert.equal(((await response.json()) as { readonly error: string }).error, "payload_too_large");
  assert.equal((await fetch(`${relay.url}/health`)).status, 200);
});

test("malformed configuration is reported rather than guessed at", () => {
  const badPort = serveOptionsFromEnv({ WEFT_TOKENS: "t:s:d", WEFT_PORT: "not-a-port" });
  assert.equal(badPort.ok, false);
  assert.match(badPort.ok ? "" : badPort.errors.join(), /WEFT_PORT is not a port/u);

  const badToken = serveOptionsFromEnv({ WEFT_TOKENS: "token-without-scope" });
  assert.equal(badToken.ok, false);
  assert.match(badToken.ok ? "" : badToken.errors.join(), /token:scope_id:device_id/u);
});

test("the HTTP pull cursor must be finite, so a malformed cursor cannot skip records", async (t) => {
  const relay = await listen(t);
  const auth = { authorization: "Bearer token", "content-type": "application/json" };
  const push = await fetch(`${relay.url}/push`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      ops: [
        {
          scopeId: "scope-1",
          tableName: "tasks",
          rowId: "task-1",
          kind: "create",
          hlc: "00000000zzzzzzz-000000-device-1",
          txnId: txnId("t1"),
        },
        {
          scopeId: "scope-1",
          tableName: "tasks",
          rowId: "task-1",
          kind: "set",
          field: "title",
          value: "must not be skipped",
          hlc: "00000000zzzzzzz-000001-device-1",
          txnId: txnId("t1"),
        },
      ],
    }),
  });
  assert.equal(push.status, 200);

  await fc.assert(
    fc.asyncProperty(fc.constantFrom("NaN", "Infinity", "-Infinity", "not-a-number"), async (cursor) => {
      const response = await fetch(`${relay.url}/pull?last_server_seq=${encodeURIComponent(cursor)}`, {
        headers: auth,
      });
      assert.equal(response.status, 400, `${cursor} was accepted as a pull cursor`);
    }),
  );
});

test("malformed push ops are bad requests, not protocol transactions", async (t) => {
  const relay = await listen(t);
  const auth = { authorization: "Bearer token", "content-type": "application/json" };

  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.record({
          ops: fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.dictionary(fc.string(), fc.string()),
          ),
        }),
        fc.record({
          ops: fc.array(
            fc.oneof(
              fc.string(),
              fc.integer(),
              fc.boolean(),
              fc.constant(null),
              fc.dictionary(fc.string(), fc.string()),
            ),
            { minLength: 1, maxLength: 3 },
          ),
        }),
      ),
      async (body) => {
        const response = await fetch(`${relay.url}/push`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, `${JSON.stringify(body)} was handled as a protocol push`);

        const pull = await fetch(`${relay.url}/pull?last_server_seq=0`, { headers: auth });
        const batch = (await pull.json()) as { readonly fields: readonly unknown[]; readonly rows: readonly unknown[] };
        assert.deepEqual(batch.fields, [], "a malformed push changed field state");
        assert.deepEqual(batch.rows, [], "a malformed push changed row state");
      },
    ),
    { numRuns: 50 },
  );
});

test("malformed handshake schema metadata is refused before it poisons the scope", async (t) => {
  const relay = await listen(t);
  const response = await fetch(`${relay.url}/handshake`, {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify({ scopeId: "scope-1", schemaHash: {}, schemaVersion: 1.5, lastServerSeq: 0 }),
  });
  assert.equal(response.status, 400);
  assert.equal(relay.server.scopes.has(scopeId("scope-1")), false, "a malformed handshake created scope metadata");
  assert.equal(relay.server.devices.size, 0, "a malformed handshake registered a device");
});

test("storage defaults to memory only when no database path is configured", () => {
  const memory = serveOptionsFromEnv({ WEFT_TOKENS: "t:s:d" });
  assert.equal(memory.ok && memory.options.databasePath, undefined);

  const persisted = serveOptionsFromEnv({ WEFT_TOKENS: "t:s:d", WEFT_DB: "/data/weft.sqlite" });
  assert.equal(persisted.ok && persisted.options.databasePath, "/data/weft.sqlite");

  const cleared = serveOptionsFromEnv({ WEFT_TOKENS: "t:s:d", WEFT_DB: "" });
  assert.equal(cleared.ok && cleared.options.databasePath, undefined);
});

test("the HTTP relay serves the protocol end to end", async (t) => {
  const relay = await listen(t);
  const auth = { authorization: "Bearer token", "content-type": "application/json" };

  const health = await fetch(`${relay.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  assert.equal((await fetch(`${relay.url}/pull?last_server_seq=0`)).status, 401);

  const handshake = await fetch(`${relay.url}/handshake`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ scopeId: "scope-1", schemaHash: "hash", schemaVersion: 1, lastServerSeq: 0 }),
  });
  assert.equal(handshake.status, 200);
  assert.deepEqual(await handshake.json(), { ok: true });

  const push = await fetch(`${relay.url}/push`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      ops: [
        {
          scopeId: "scope-1",
          tableName: "tasks",
          rowId: "task-1",
          kind: "create",
          hlc: "00000000zzzzzzz-000000-device-1",
          txnId: txnId("t1"),
        },
        {
          scopeId: "scope-1",
          tableName: "tasks",
          rowId: "task-1",
          kind: "set",
          field: "title",
          value: "over http",
          hlc: "00000000zzzzzzz-000001-device-1",
          txnId: txnId("t1"),
        },
      ],
    }),
  });
  assert.equal(push.status, 200);
  assert.equal(((await push.json()) as { readonly ok: boolean }).ok, true);

  const pull = await fetch(`${relay.url}/pull?last_server_seq=0`, { headers: auth });
  const batch = (await pull.json()) as {
    readonly fields: readonly { readonly value: unknown }[];
    readonly tombstoneFloorSeq: number;
  };
  assert.deepEqual(
    batch.fields.map((field) => field.value),
    ["over http"],
  );
  assert.equal(batch.tombstoneFloorSeq, 0);

  const snapshot = await fetch(`${relay.url}/snapshot`, { headers: auth });
  assert.match(((await snapshot.json()) as { readonly body: string }).body, /"type":"header"/u);
});

test("a malformed body is answered, not crashed on", async (t) => {
  const relay = await listen(t);
  const response = await fetch(`${relay.url}/push`, {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { readonly error: string }).error, "bad_request");

  // The listener survives it and still serves the next request.
  assert.equal((await fetch(`${relay.url}/health`)).status, 200);
});

test("a zero prune interval turns the sweep off", async (t) => {
  const relay = await listen(t, { pruneIntervalMs: 0, pruneOlderThanMs: 0 });
  const scope = scopeId("scope-1");
  const table = tableName("tasks");
  const row = rowId("ancient");
  // Old enough, and with a cutoff of zero, that any sweep at all would take it. A surviving row
  // can only mean no timer was started.
  relay.server.push(scope, tombstoneOps(scope, table, row, Date.now() - 400 * 24 * 60 * 60 * 1000));

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hasRow(relay, scope, table, row), true, "a relay with the sweep off pruned a tombstone");
  assert.equal(relay.server.scopes.get(scope)?.tombstoneFloorSeq ?? 0, 0);
});

test("pruning runs without being configured, because the protocol assumes it has", async (t) => {
  // The default interval is a day, so this asserts a timer exists rather than waiting for a tick:
  // an unconfigured relay that scheduled nothing would leave the floor unable to ever advance.
  const relay = await listen(t);
  const scope = scopeId("scope-1");
  relay.server.push(scope, tombstoneOps(scope, tableName("tasks"), rowId("old"), Date.now()));

  assert.equal(relay.server.scopes.get(scope)?.tombstoneFloorSeq ?? 0, 0, "nothing has swept yet");
  relay.server.pruneTombstones(scope, 0);
  assert.ok(
    (relay.server.scopes.get(scope)?.tombstoneFloorSeq ?? 0) > 0,
    "the sweep the default schedule performs does not advance the floor",
  );
});

test("a configured prune interval sweeps every scope on schedule", async (t) => {
  const relay = await listen(t, {
    pruneIntervalMs: 20,
    // Zero means "older than right now", so the tombstone pushed below is eligible on the very
    // first sweep without the test needing to wait out a real cutoff window.
    pruneOlderThanMs: 0,
  });
  const scope = scopeId("scope-1");
  const table = tableName("tasks");
  const row = rowId("stale");
  relay.server.push(scope, tombstoneOps(scope, table, row, Date.now() - 5));

  await waitFor(() => !hasRow(relay, scope, table, row), "the scheduled prune never ran");
  assert.equal(
    (relay.server.scopes.get(scope)?.tombstoneFloorSeq ?? 0) > 0,
    true,
    "the tombstone floor did not advance",
  );
});

test("closing the relay stops the scheduled prune", async () => {
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    tokens: new Map([
      ["token", { scopeId: scopeId("scope-1"), deviceId: "device-1" as import("weftdb/core").DeviceId }],
    ]),
    pruneIntervalMs: 20,
    pruneOlderThanMs: 0,
  });
  await relay.close();

  const scope = scopeId("scope-1");
  const table = tableName("tasks");
  const row = rowId("post-close");
  // The in-memory server outlives `close()` — only the timer, sockets and HTTP listener are
  // torn down — so pushing directly to it is what tells apart "the timer was cleared" from
  // "there was nothing left to prune".
  relay.server.push(scope, tombstoneOps(scope, table, row, Date.now() - 5));

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hasRow(relay, scope, table, row), true, "a closed relay's prune timer still fired");
});

/** A create followed by a delete stamped at `deletedAtMs`, so the row is a tombstone at that age. */
function tombstoneOps(
  scope: import("weftdb/core").ScopeId,
  table: import("weftdb/core").TableName,
  row: import("weftdb/core").RowId,
  deletedAtMs: number,
): WeftOp[] {
  const seed = deviceId("seed");
  return [
    {
      scopeId: scope,
      tableName: table,
      rowId: row,
      kind: "create",
      hlc: encodeHlc({ wallMs: deletedAtMs - 1, counter: 0, deviceId: seed }),
      txnId: txnId(`${row}-create`),
    },
    {
      scopeId: scope,
      tableName: table,
      rowId: row,
      kind: "delete",
      hlc: encodeHlc({ wallMs: deletedAtMs, counter: 0, deviceId: seed }),
      txnId: txnId(`${row}-delete`),
    },
  ];
}

function hasRow(
  relay: RunningServer,
  scope: import("weftdb/core").ScopeId,
  table: import("weftdb/core").TableName,
  row: import("weftdb/core").RowId,
): boolean {
  return relay.server
    .snapshot(scope)
    .rows.some((candidate) => candidate.tableName === table && candidate.rowId === row);
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function listen(t: import("vitest").TestContext, overrides: Partial<ServeOptions> = {}): Promise<RunningServer> {
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    tokens: new Map([
      ["token", { scopeId: scopeId("scope-1"), deviceId: "device-1" as import("weftdb/core").DeviceId }],
    ]),
    ...overrides,
  });
  t.onTestFinished(() => relay.close());
  return relay;
}
