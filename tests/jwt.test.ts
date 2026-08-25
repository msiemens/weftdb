// The JWT verifier. Authorization is scope equality and nothing more (§1.4), so everything a
// token decides comes down to which `AuthContext` it resolves to — and every way of getting a
// token accepted that should not be is a way into somebody else's scope.
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, generateKeyPairSync, createSign } from "node:crypto";
import { scopeId, deviceId } from "weftdb/shared";
import { claimsToContext, jwtVerifier, type JwtClaims } from "weftdb/server/jwt";

const SECRET = "a-shared-secret-that-is-long-enough";
const NOW = Date.parse("2026-03-01T09:00:00.000Z");
const now = (): number => NOW;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function hs256(
  claims: JwtClaims,
  secret = SECRET,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const signed = `${encode(header)}.${encode(claims)}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

const verifier = jwtVerifier({
  keys: () => SECRET,
  algorithms: ["HS256"],
  context: claimsToContext,
  issuer: "https://issuer.example",
  audience: "weft",
  now,
});

const valid: JwtClaims = {
  iss: "https://issuer.example",
  aud: "weft",
  scope: "shared-list",
  device: "laptop",
  exp: Math.floor(NOW / 1000) + 3600,
};

test("a well-formed token resolves to the scope and device its claims name", async () => {
  assert.deepEqual(await verifier.verify(hs256(valid)), {
    scopeId: scopeId("shared-list"),
    deviceId: deviceId("laptop"),
  });
});

test("`sub` names the device when there is no device claim", async () => {
  const { device: _device, ...withoutDevice } = valid;
  assert.deepEqual(await verifier.verify(hs256({ ...withoutDevice, sub: "phone" })), {
    scopeId: scopeId("shared-list"),
    deviceId: deviceId("phone"),
  });
});

test("a token signed with the wrong key is refused", async () => {
  assert.equal(await verifier.verify(hs256(valid, "not-the-secret")), undefined);
});

test("a token whose payload was edited after signing is refused", async () => {
  const token = hs256(valid);
  const [header, , signature] = token.split(".");
  const tampered = `${header}.${encode({ ...valid, scope: "someone-elses-list" })}.${signature}`;
  assert.equal(await verifier.verify(tampered), undefined);
});

test("a token may not choose its own algorithm", async () => {
  // `alg: none` and algorithm confusion are the two classic ways a token talks a verifier out
  // of checking it, so the accepted algorithms come from the deployment and the header is only
  // ever matched against them.
  const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode(valid)}.`;
  assert.equal(await verifier.verify(unsigned), undefined);

  const publicKeyOnly = jwtVerifier({
    keys: () => SECRET,
    algorithms: ["RS256"],
    context: claimsToContext,
    now,
  });
  assert.equal(
    await publicKeyOnly.verify(hs256(valid)),
    undefined,
    "an HMAC token was accepted where RSA was configured",
  );
});

test("expiry, not-before, issuer and audience are all enforced", async () => {
  const cases: readonly (readonly [string, JwtClaims])[] = [
    ["expired", { ...valid, exp: Math.floor(NOW / 1000) - 3600 }],
    ["not yet valid", { ...valid, nbf: Math.floor(NOW / 1000) + 3600 }],
    ["another issuer", { ...valid, iss: "https://elsewhere.example" }],
    ["another audience", { ...valid, aud: "something-else" }],
  ];
  for (const [name, claims] of cases) {
    assert.equal(await verifier.verify(hs256(claims)), undefined, `a token for ${name} was accepted`);
  }
});

test("a clock a little out of step is tolerated, a lot is not", async () => {
  const justExpired: JwtClaims = { ...valid, exp: Math.floor(NOW / 1000) - 30 };
  assert.notEqual(await verifier.verify(hs256(justExpired)), undefined, "a token 30s past expiry was refused");
  const longExpired: JwtClaims = { ...valid, exp: Math.floor(NOW / 1000) - 600 };
  assert.equal(await verifier.verify(hs256(longExpired)), undefined);
});

test("a token with no scope claim resolves to nothing rather than a default", async () => {
  const { scope: _scope, ...withoutScope } = valid;
  assert.equal(await verifier.verify(hs256(withoutScope)), undefined);
  assert.equal(await verifier.verify(hs256({ ...valid, scope: "" })), undefined);
});

test("an unknown key id is refused rather than falling back to another key", async () => {
  const keyed = jwtVerifier({
    keys: (header) => (header.kid === "current" ? SECRET : undefined),
    algorithms: ["HS256"],
    context: claimsToContext,
    now,
  });
  assert.notEqual(await keyed.verify(hs256(valid, SECRET, { alg: "HS256", kid: "current" })), undefined);
  assert.equal(await keyed.verify(hs256(valid, SECRET, { alg: "HS256", kid: "retired" })), undefined);
});

test("an asymmetric token verifies against the public key alone", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsa = jwtVerifier({ keys: () => publicKey, algorithms: ["RS256"], context: claimsToContext, now });

  const signed = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(valid)}`;
  const signer = createSign("SHA256");
  signer.update(signed);
  signer.end();
  const token = `${signed}.${signer.sign(privateKey).toString("base64url")}`;

  assert.deepEqual(await rsa.verify(token), { scopeId: scopeId("shared-list"), deviceId: deviceId("laptop") });
  const { publicKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const otherVerifier = jwtVerifier({ keys: () => otherKey, algorithms: ["RS256"], context: claimsToContext, now });
  assert.equal(await otherVerifier.verify(token), undefined, "a token verified against a key that did not sign it");
});

test("nonsense in place of a token is refused without throwing", async () => {
  for (const token of ["", "not-a-token", "a.b", "a.b.c.d", "...", `${encode({ alg: "HS256" })}..`]) {
    assert.equal(await verifier.verify(token), undefined, `${JSON.stringify(token)} was not refused`);
  }
});
