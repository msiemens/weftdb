// Who the demo relay lets in. A deployment issues tokens after sign-in; here the goal is a second
// tab without a sign-up flow, so any tab may name itself. That is why the relay binds to loopback
// and this verifier is not something to copy into production.
//
// One relay serves every demo, and every visitor to them. It is schema-blind, so it needs to know
// nothing about any of their schemas; scope equality is the whole of the authorization model, and
// it is what keeps the todo list apart from the chat and one visitor apart from the next. The
// scope therefore travels in the token rather than being fixed here, since no value fixed here
// could serve more than one demo.
//
// This verifier hands out whatever scope the token names, so a visitor's rows are protected only
// by their scope id being long and random (see `visitorScope` in `identity.ts`). Anyone who learns
// a scope id can read it, which is acceptable for throwaway demo data on a relay bound to loopback,
// and is why `jwtVerifier` exists for anything else.
import { deviceId, scopeId } from "weftdb/core";
import type { TokenVerifier } from "weftdb/server/relay";

const PREFIX = "demo";

/**
 * The separator has to be a character RFC 6455 allows in a subprotocol name. The browser cannot
 * set headers on a WebSocket, so the token travels as `weft.token.<token>` in
 * `Sec-WebSocket-Protocol`. Those values are HTTP tokens, where a colon is not a legal token
 * character, so a colon here makes the `WebSocket` constructor throw and the page falls back to
 * polling with nothing in the console explaining why.
 *
 * A dot is legal there, and neither a scope id nor a device id contains one, so the prefix, the
 * scope and the device still split apart unambiguously. A hyphen would not, since device ids are
 * `tab-1-abcd`.
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
