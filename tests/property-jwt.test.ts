// The JWT verifier, under generated tokens. Authorization is scope equality and nothing more
// (§1.4), so a verifier is the whole of a deployment's access control: every token it accepts
// that it should not is a way into somebody else's scope, and every claim it reads wrongly is a
// device acting as one it is not.
//
// The example-based suite next to this one covers the attacks by name. These cover the space
// around them: every mutation of a valid token, every algorithm a header can name, every
// position of `now` against a validity window. An attacker picks the case, and the cases nobody
// thought to write down are the ones left.
import assert from "node:assert/strict";
import { test } from "vitest";
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import fc from "fast-check";
import { deviceId, scopeId } from "weftdb/core";
import { claimsToContext, jwtVerifier, type JwtAlgorithm, type JwtClaims } from "weftdb/server/jwt";

const SECRET = "a-shared-secret-that-is-long-enough";
const NOW_SECONDS = Math.floor(Date.parse("2026-03-01T09:00:00.000Z") / 1000);
const RUNS = Number(process.env["WEFT_PROPERTY_RUNS"] ?? 300);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });

/** How each algorithm signs, and what key verifies it. */
const SIGNERS: ReadonlyMap<
  JwtAlgorithm,
  { readonly sign: (signed: string) => string; readonly key: KeyObject | string }
> = new Map([
  ["HS256", { sign: (signed) => hmac("sha256", SECRET, signed), key: SECRET }],
  ["HS384", { sign: (signed) => hmac("sha384", SECRET, signed), key: SECRET }],
  ["HS512", { sign: (signed) => hmac("sha512", SECRET, signed), key: SECRET }],
  ["RS256", { sign: (signed) => rsaSign("SHA256", signed), key: rsa.publicKey }],
  ["ES256", { sign: (signed) => ecSign("SHA256", signed), key: ec.publicKey }],
]);

const ALGORITHMS = [...SIGNERS.keys()];

const nameArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM0123456789-_.:"), { minLength: 1, maxLength: 16 })
  .map((characters) => characters.join(""));

const algorithmArb = fc.constantFrom(...ALGORITHMS);

test("a token signed as the deployment expects resolves to exactly the scope and device it names", () => {
  fc.assert(
    fc.property(algorithmArb, nameArb, nameArb, (algorithm, scope, device) => {
      const verifier = verifierFor([algorithm]);
      const token = sign(algorithm, { scope, device, exp: NOW_SECONDS + 3600 });

      // A verifier that resolved a token to any other scope would be handing one person's
      // device another person's data.
      assert.deepEqual(verify(verifier, token), { scopeId: scopeId(scope), deviceId: deviceId(device) });
    }),
    { numRuns: Math.min(RUNS, 200) },
  );
});

test("no single-character change to a token goes unnoticed", () => {
  // A signature is over the encoded header and payload as text, so any change to either is a
  // different message. The one thing a change can be is invisible, because base64url leaves
  // spare bits in a final character, and two spellings of the same bytes are the same signature.
  fc.assert(
    fc.property(
      algorithmArb,
      nameArb,
      nameArb,
      fc.nat(),
      fc.constantFrom(..."ABCXYZabcxyz0189-_."),
      (algorithm, scope, device, position, replacement) => {
        const verifier = verifierFor([algorithm]);
        const token = sign(algorithm, { scope, device, exp: NOW_SECONDS + 3600 });
        const index = position % token.length;
        const mutated = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
        fc.pre(mutated !== token);

        assert.deepEqual(verify(verifier, mutated), sameMessage(token, mutated) ? verify(verifier, token) : undefined);
      },
    ),
    { numRuns: Math.min(RUNS, 400) },
  );
});

test("the algorithm is the deployment's to choose, never the token's", () => {
  fc.assert(
    fc.property(algorithmArb, algorithmArb, nameArb, nameArb, (configured, claimed, scope, device) => {
      // The token is signed correctly for the algorithm its header names, so a verifier that
      // trusts the header will check it, find it sound, and let it in.
      const verifier = verifierFor([configured]);
      const token = sign(claimed, { scope, device, exp: NOW_SECONDS + 3600 });
      assert.equal(verify(verifier, token) === undefined, claimed !== configured);
    }),
    { numRuns: Math.min(RUNS, 200) },
  );
});

test("a header naming anything else at all is refused", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constantFrom("none", "None", "NONE", "hs256", "HS257", "RS256 ", "", "HS256\0", "PS256", "EdDSA"),
        nameArb,
      ),
      nameArb,
      (claimed, scope) => {
        fc.pre(!ALGORITHMS.includes(claimed as JwtAlgorithm));
        const verifier = verifierFor(ALGORITHMS);
        const claims: JwtClaims = { scope, device: "device", exp: NOW_SECONDS + 3600 };
        // Signed every way the deployment does accept, so nothing but the header's name is
        // left to refuse it on.
        for (const algorithm of ALGORITHMS) {
          const signed = `${encode({ alg: claimed, typ: "JWT" })}.${encode(claims)}`;
          const signature = SIGNERS.get(algorithm)?.sign(signed) ?? "";
          assert.equal(
            verify(verifier, `${signed}.${signature}`),
            undefined,
            `a header naming ${claimed} was accepted`,
          );
        }
        assert.equal(verify(verifier, `${encode({ alg: claimed })}.${encode(claims)}.`), undefined);
      },
    ),
    { numRuns: Math.min(RUNS, 120) },
  );
});

test("a public key is not a shared secret", () => {
  // Algorithm confusion, where the attacker knows the public key, because it is public, and
  // offers it back as the HMAC secret. It only works on a verifier that lets the token pick the
  // algorithm.
  fc.assert(
    fc.property(nameArb, fc.constantFrom("RS256" as const, "ES256" as const), (scope, algorithm) => {
      const key = algorithm === "RS256" ? rsa.publicKey : ec.publicKey;
      const material = key.export({ type: "spki", format: "pem" }).toString();
      const verifier = jwtVerifier({
        keys: () => key,
        algorithms: [algorithm],
        context: claimsToContext,
        now: () => NOW_SECONDS * 1000,
      });
      const signed = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ scope, device: "attacker", exp: NOW_SECONDS + 3600 })}`;

      assert.equal(verify(verifier, `${signed}.${hmac("sha256", material, signed)}`), undefined);
      assert.equal(verify(verifier, `${signed}.${hmac("sha256", material.trim(), signed)}`), undefined);
    }),
    { numRuns: Math.min(RUNS, 60) },
  );
});

test("a token is valid exactly while its window says so, give or take the tolerance", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -7200, max: 7200 }),
      fc.option(fc.integer({ min: -7200, max: 7200 }), { nil: undefined }),
      fc.option(fc.integer({ min: -7200, max: 7200 }), { nil: undefined }),
      fc.integer({ min: 0, max: 600 }),
      (offset, expOffset, nbfOffset, tolerance) => {
        const at = (NOW_SECONDS + offset) * 1000;
        const claims: JwtClaims = {
          scope: "shared-list",
          device: "laptop",
          ...(expOffset === undefined ? {} : { exp: NOW_SECONDS + expOffset }),
          ...(nbfOffset === undefined ? {} : { nbf: NOW_SECONDS + nbfOffset }),
        };
        const verifier = jwtVerifier({
          keys: () => SECRET,
          algorithms: ["HS256"],
          context: claimsToContext,
          clockToleranceSeconds: tolerance,
          now: () => at,
        });

        const within =
          (claims.exp === undefined || at <= claims.exp * 1000 + tolerance * 1000) &&
          (claims.nbf === undefined || at >= claims.nbf * 1000 - tolerance * 1000);
        assert.equal(verify(verifier, sign("HS256", claims)) !== undefined, within);
      },
    ),
    { numRuns: Math.min(RUNS, 300) },
  );
});

test("temporal claims are numeric dates, not coercible values", () => {
  const nonNumericClaimArb = fc.oneof(
    fc.string({ maxLength: 16 }),
    fc.boolean(),
    fc.constant(null),
    fc.constant({}),
    fc.array(fc.integer(), { maxLength: 3 }),
  );
  fc.assert(
    fc.property(fc.constantFrom("exp", "nbf"), nonNumericClaimArb, (claim, value) => {
      const verifier = jwtVerifier({
        keys: () => SECRET,
        algorithms: ["HS256"],
        context: claimsToContext,
        now: () => NOW_SECONDS * 1000,
      });
      const token = sign("HS256", { scope: "shared-list", device: "laptop", [claim]: value });

      assert.equal(
        verify(verifier, token),
        undefined,
        `${claim}=${JSON.stringify(value)} was accepted as a NumericDate`,
      );
    }),
    { numRuns: Math.min(RUNS, 300) },
  );
});

test("issuer and audience are matched, not merely present", () => {
  fc.assert(
    fc.property(
      nameArb,
      nameArb,
      nameArb,
      nameArb,
      fc.boolean(),
      (issuer, audience, tokenIssuer, tokenAudience, asList) => {
        const verifier = jwtVerifier({
          keys: () => SECRET,
          algorithms: ["HS256"],
          context: claimsToContext,
          issuer,
          audience,
          now: () => NOW_SECONDS * 1000,
        });
        const token = sign("HS256", {
          scope: "shared-list",
          device: "laptop",
          iss: tokenIssuer,
          // A list is the awkward case, since membership rather than equality decides it, and a
          // list that merely contains something similar is not membership.
          aud: asList ? [`${tokenAudience}-other`, tokenAudience] : tokenAudience,
          exp: NOW_SECONDS + 3600,
        });

        assert.equal(verify(verifier, token) !== undefined, tokenIssuer === issuer && tokenAudience === audience);
      },
    ),
    { numRuns: Math.min(RUNS, 200) },
  );
});

test("a key is chosen by key id, and an unknown one falls back to nothing", () => {
  fc.assert(
    fc.property(nameArb, nameArb, nameArb, (current, retired, requested) => {
      fc.pre(current !== retired);
      const secrets = new Map([
        [current, SECRET],
        [retired, `${SECRET}-retired`],
      ]);
      const verifier = jwtVerifier({
        // Only the current key is still trusted, which is what retiring one means.
        keys: (header) => (header.kid === current ? SECRET : undefined),
        algorithms: ["HS256"],
        context: claimsToContext,
        now: () => NOW_SECONDS * 1000,
      });
      const claims: JwtClaims = { scope: "shared-list", device: "laptop", exp: NOW_SECONDS + 3600 };
      const signed = `${encode({ alg: "HS256", kid: requested })}.${encode(claims)}`;
      const token = `${signed}.${hmac("sha256", secrets.get(requested) ?? "guessed", signed)}`;

      assert.equal(verify(verifier, token) !== undefined, requested === current);
    }),
    { numRuns: Math.min(RUNS, 120) },
  );
});

test("nothing a client can send makes the verifier throw", () => {
  // A verifier that throws on a malformed token hands an unauthenticated caller a way to take
  // the connection down, and the token is the first thing anyone sends.
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ unit: "binary", maxLength: 200 }),
        fc
          .array(fc.string({ unit: "binary", maxLength: 60 }), { minLength: 0, maxLength: 5 })
          .map((parts) => parts.join(".")),
        fc
          .array(fc.uint8Array({ maxLength: 40 }), { minLength: 3, maxLength: 3 })
          .map((segments) => segments.map((bytes) => Buffer.from(bytes).toString("base64url")).join(".")),
        fc
          .record({ alg: fc.string({ maxLength: 8 }), typ: fc.string({ maxLength: 8 }) })
          .map((header) => `${encode(header)}..`),
      ),
      (token) => {
        const verifier = verifierFor(ALGORITHMS);
        assert.equal(verify(verifier, token), undefined);
      },
    ),
    { numRuns: Math.min(RUNS, 400) },
  );
});

test("claims resolve to a context only when they name both a scope and a device", () => {
  fc.assert(
    fc.property(
      fc.oneof(nameArb, fc.constant(""), fc.constant(undefined), fc.constant(42), fc.constant(null), fc.constant({})),
      fc.oneof(nameArb, fc.constant(""), fc.constant(undefined), fc.constant(42)),
      fc.oneof(nameArb, fc.constant(""), fc.constant(undefined)),
      (scope, device, subject) => {
        const claims = {
          ...(scope === undefined ? {} : { scope }),
          ...(device === undefined ? {} : { device }),
          ...(subject === undefined ? {} : { sub: subject }),
        } as JwtClaims;
        const context = claimsToContext(claims);

        // `sub` stands in for a device claim that is missing or is not a name; nothing stands
        // in for a missing scope.
        const expectedDevice = typeof device === "string" ? device : typeof subject === "string" ? subject : undefined;
        const usable =
          typeof scope === "string" && scope !== "" && expectedDevice !== undefined && expectedDevice !== "";
        assert.equal(context !== undefined, usable);
        if (context !== undefined) {
          assert.equal(String(context.scopeId), scope);
          assert.equal(String(context.deviceId), expectedDevice);
        }
      },
    ),
    { numRuns: Math.min(RUNS, 300) },
  );
});

function verifierFor(algorithms: readonly JwtAlgorithm[]) {
  return jwtVerifier({
    keys: (header) => SIGNERS.get(header.alg as JwtAlgorithm)?.key,
    algorithms,
    context: claimsToContext,
    now: () => NOW_SECONDS * 1000,
  });
}

/** The verifier answers synchronously; the port allows a promise, so the shape is asserted. */
function verify(verifier: ReturnType<typeof jwtVerifier>, token: string): ReturnType<typeof claimsToContext> {
  const outcome = verifier.verify(token);
  assert.equal(outcome instanceof Promise, false, "the verifier under test is expected to answer without awaiting");
  return outcome as ReturnType<typeof claimsToContext>;
}

function sign(algorithm: JwtAlgorithm, claims: JwtClaims): string {
  const signer = SIGNERS.get(algorithm);
  if (signer === undefined) throw new Error(`no signer for ${algorithm}`);
  const signed = `${encode({ alg: algorithm, typ: "JWT" })}.${encode(claims)}`;
  return `${signed}.${signer.sign(signed)}`;
}

/** Two tokens are the same message when the same text was signed over the same signature bytes. */
function sameMessage(left: string, right: string): boolean {
  const [leftHeader, leftPayload, leftSignature] = left.split(".");
  const [rightHeader, rightPayload, rightSignature, extra] = right.split(".");
  if (extra !== undefined || rightSignature === undefined || leftSignature === undefined) return false;
  if (leftHeader !== rightHeader || leftPayload !== rightPayload) return false;
  return Buffer.from(leftSignature, "base64url").equals(Buffer.from(rightSignature, "base64url"));
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function hmac(digest: string, secret: string, signed: string): string {
  return createHmac(digest, secret).update(signed).digest("base64url");
}

function rsaSign(digest: string, signed: string): string {
  const signer = createSign(digest);
  signer.update(signed);
  signer.end();
  return signer.sign(rsa.privateKey).toString("base64url");
}

function ecSign(digest: string, signed: string): string {
  const signer = createSign(digest);
  signer.update(signed);
  signer.end();
  return signer.sign({ key: ec.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}
