// Who the demo relay lets in. A deployment issues tokens after sign-in; here the point is to open
// a second tab without a sign-up flow, so any tab may name itself — which is exactly why the relay
// binds to loopback and this verifier is not something to copy into production.
//
// One relay serves every demo, and every visitor to them. It is schema-blind, so it needs to know
// nothing about any of their schemas; scope equality is the whole of the authorization model, and
// it is what keeps the todo list apart from the chat and one visitor apart from the next. That is
// why the scope travels in the token rather than being fixed here.
//
// This verifier hands out whatever scope the token names, so a visitor's rows are protected only
// by their scope id being long and random (see `visitorScope` in `identity.ts`). Unguessable is
// not the same as unauthorized: anyone who learns a scope id can read it. That is acceptable for
// throwaway demo data on a relay bound to loopback, and it is why `jwtVerifier` exists for
// anything else.
import { deviceId, scopeId } from "weftdb/core";
import type { TokenVerifier } from "weftdb/server/relay";

const PREFIX = "demo";

/**
 * The separator has to be a character RFC 6455 allows in a subprotocol name, because that is how
 * the token reaches the relay: the browser cannot set headers on a WebSocket, so it travels as
 * `weft.token.<token>` in `Sec-WebSocket-Protocol`. Those values are HTTP tokens, and a colon is a
 * separator rather than a token character, so a colon here makes the `WebSocket` constructor throw
 * and the page falls back to polling with nothing in the console explaining why.
 *
 * A dot is legal there, and neither a scope id nor a device id contains one, so the three parts
 * still split apart unambiguously. A hyphen would not have: device ids are `tab-1-abcd`.
 */
const SEPARATOR = ".";
export function demoToken(scope: string, device: string): string {
  return [PREFIX, scope, device].join(SEPARATOR);
}

/** A `demo.<scope>.<device>` token names that device inside that scope, and nothing else. */
export const demoVerifier: TokenVerifier = {
  verify: (token) => {
    const parts = token.split(SEPARATOR);
    if (parts.length !== 3) return undefined;
    const [prefix, scope, device] = parts;
    if (prefix !== PREFIX) return undefined;
    if (scope === undefined || scope === "") return undefined;
    if (device === undefined || device === "") return undefined;
    return { scopeId: scopeId(scope), deviceId: deviceId(device) };
  },
};
