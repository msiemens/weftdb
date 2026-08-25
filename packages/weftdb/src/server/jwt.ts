// A `TokenVerifier` that checks a signed JWT, for deployments that issue tokens rather than
// list them. The static table this ships alongside suits one self-hosted relay; anything with
// more than one user needs tokens that expire, and that means a signature to check.
//
// Deliberately small: HMAC and RSA/ECDSA verification with keys the caller supplies, no
// network, no key discovery. Fetching a JWKS, caching it and rotating on `kid` is a policy
// decision — the `keys` callback is where that goes, so this file never has to know.
import { createHmac, createPublicKey, createVerify, KeyObject, timingSafeEqual } from "node:crypto";
import { deviceId, scopeId } from "weftdb/shared";
import type { AuthContext, TokenVerifier } from "./relay.ts";

export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

export interface JwtClaims {
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly sub?: string;
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly [claim: string]: unknown;
}

/** The algorithms this verifies. Anything else is refused rather than guessed at. */
export type JwtAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "RS384" | "RS512" | "ES256" | "ES384";

export interface JwtVerifierOptions {
  /**
   * The key for a token's header. A shared secret verifies HMAC; a public key verifies the
   * rest. Returning nothing refuses the token, which is how an unknown `kid` is handled.
   */
  readonly keys: (header: JwtHeader) => KeyObject | string | Buffer | undefined;
  /** Algorithms this deployment accepts. A token naming anything else is refused. */
  readonly algorithms: readonly JwtAlgorithm[];
  /** Which scope and device the claims name. Returning nothing refuses the token. */
  readonly context: (claims: JwtClaims) => AuthContext | undefined;
  readonly issuer?: string;
  readonly audience?: string;
  /** Tolerance for clocks that disagree, in seconds. */
  readonly clockToleranceSeconds?: number;
  readonly now?: () => number;
}

/**
 * The common case: `scope` and `device` claims naming them directly, with `sub` as the device
 * when there is no `device` claim.
 */
export function claimsToContext(claims: JwtClaims): AuthContext | undefined {
  const scope = typeof claims["scope"] === "string" ? claims["scope"] : undefined;
  const device = typeof claims["device"] === "string" ? claims["device"] : claims.sub;
  if (scope === undefined || device === undefined || scope === "" || device === "") return undefined;
  return { scopeId: scopeId(scope), deviceId: deviceId(device) };
}

export function jwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  const now = options.now ?? Date.now;
  const tolerance = (options.clockToleranceSeconds ?? 60) * 1000;

  return {
    verify: (token) => {
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined)
        return undefined;

      const header = decodeJson<JwtHeader>(encodedHeader);
      const claims = decodeJson<JwtClaims>(encodedPayload);
      if (header === undefined || claims === undefined) return undefined;

      // The algorithm comes from the deployment, never from the token: a token that names
      // `none`, or names HMAC where a public key is configured, is choosing its own verifier.
      const algorithm = options.algorithms.find((candidate) => candidate === header.alg);
      if (algorithm === undefined) return undefined;

      const key = options.keys(header);
      if (key === undefined) return undefined;
      if (!verifySignature(algorithm, key, `${encodedHeader}.${encodedPayload}`, encodedSignature)) return undefined;

      // A NumericDate is a number, and these claims arrive as whatever JSON the issuer wrote.
      // Arithmetic on anything else gives `NaN`, every comparison against `NaN` is false, and a
      // token with `exp: ":"` would simply never expire.
      const expiresAt = numericDate(claims.exp);
      const notBefore = numericDate(claims.nbf);
      if (expiresAt === "invalid" || notBefore === "invalid") return undefined;

      const at = now();
      if (expiresAt !== undefined && at > expiresAt * 1000 + tolerance) return undefined;
      if (notBefore !== undefined && at < notBefore * 1000 - tolerance) return undefined;
      if (options.issuer !== undefined && claims.iss !== options.issuer) return undefined;
      if (options.audience !== undefined && !audienceMatches(claims.aud, options.audience)) return undefined;

      return options.context(claims);
    },
  };
}

/** Absent, a finite number of seconds, or a claim this server will not guess the meaning of. */
function numericDate(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : "invalid";
}

function audienceMatches(audience: JwtClaims["aud"], expected: string): boolean {
  if (typeof audience === "string") return audience === expected;
  return Array.isArray(audience) && audience.includes(expected);
}

function verifySignature(
  algorithm: JwtAlgorithm,
  key: KeyObject | string | Buffer,
  signed: string,
  signature: string,
): boolean {
  const digest = `SHA${algorithm.slice(2)}`;
  const provided = Buffer.from(signature, "base64url");
  if (algorithm.startsWith("HS")) {
    const expected = createHmac(digest, key).update(signed).digest();
    // Constant time, and length-checked first because `timingSafeEqual` throws on a mismatch.
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
  try {
    // A key that is already public is used as it is: `createPublicKey` takes key *material* or
    // a private key, and throws on a public `KeyObject`.
    const publicKey = key instanceof KeyObject && key.type === "public" ? key : createPublicKey(key);
    const verifier = createVerify(digest);
    verifier.update(signed);
    verifier.end();
    // ECDSA signatures are the raw `r || s` pair in a JWT rather than the DER the verifier
    // expects, which is what `dsaEncoding` says here.
    return verifier.verify(
      { key: publicKey, ...(algorithm.startsWith("ES") ? { dsaEncoding: "ieee-p1363" as const } : {}) },
      provided,
    );
  } catch {
    // A key that cannot be read, or a signature that is not the shape the algorithm expects.
    return false;
  }
}

function decodeJson<T>(segment: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}
