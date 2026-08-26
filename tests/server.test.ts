import assert from "node:assert/strict";
import { test } from "vitest";
import { deviceId, fieldName, rowId, scopeId, tableName, txnId } from "weftdb/core";
import { defineSchema, S, schemaHash } from "weftdb/schema";
import { inProcessTransport, WeftClient } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { contentAddressSnapshot, snapshotDigest } from "weftdb/server/snapshot";
import { authContext, createRelayHandler, staticTokenVerifier } from "weftdb/server/relay";

const schema = defineSchema({
  tasks: S.collection({
    title: S.string(),
  }),
});

test("snapshot content address is stable for unchanged snapshot", async () => {
  const scope = scopeId("snapshot-scope");
  const server = new WeftServer(() => 1_000);
  const client = new WeftClient(scope, deviceId("device"), schema, () => 1_000);
  await client.create(tableName("tasks"), rowId("task"), { [fieldName("title")]: "title" }, txnId("txn"));
  await client.syncWith(inProcessTransport(server), schemaHash(schema));

  const snapshot = server.snapshot(scope);
  assert.equal(snapshotDigest(snapshot), snapshotDigest(snapshot));
  const addressed = contentAddressSnapshot(snapshot);
  assert.equal(addressed.digest, snapshotDigest(snapshot));
  assert.equal(addressed.mediaType, "application/x-ndjson");
  assert.match(addressed.body, /"type":"header"/u);
});

test("relay authenticates token, enforces token scope, and updates devices", async () => {
  const scope = scopeId("relay-scope");
  const server = new WeftServer(() => 1_000);
  const handler = createRelayHandler({
    server,
    verifier: staticTokenVerifier(new Map([["token", authContext(scope, "relay-device")]])),
  });

  const unauthorized = await handler(new Request("https://weft.test/handshake", { method: "POST" }));
  assert.equal(unauthorized.status, 401);

  const mismatch = await handler(
    new Request("https://weft.test/handshake", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({
        scopeId: scopeId("other"),
        schemaHash: schemaHash(schema),
        schemaVersion: 1,
        lastServerSeq: 0,
      }),
    }),
  );
  assert.equal(mismatch.status, 403);

  const ok = await handler(
    new Request("https://weft.test/handshake", {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({
        scopeId: scope,
        schemaHash: schemaHash(schema),
        schemaVersion: 1,
        lastServerSeq: 0,
      }),
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(server.devices.size, 1);

  const snapshot = await handler(
    new Request("https://weft.test/snapshot", {
      method: "GET",
      headers: { authorization: "Bearer token" },
    }),
  );
  assert.equal(snapshot.status, 200);
  assert.equal(typeof ((await snapshot.json()) as { readonly digest: string }).digest, "string");
});
