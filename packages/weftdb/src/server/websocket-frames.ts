// RFC 6455 framing, only as much of it as a wake-up channel needs. Anything it does not
// understand closes the connection rather than being guessed at, because a socket that
// misreads a length is a socket that reads the next frame's bytes as payload.

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

export interface Frame {
  readonly fin: boolean;
  readonly opcode: Opcode;
  readonly payload: Buffer;
}

export type FrameRead =
  | { readonly status: "frame"; readonly frame: Frame; readonly rest: Buffer }
  /** Not enough bytes yet. TCP splits wherever it likes; the caller keeps buffering. */
  | { readonly status: "partial" }
  | { readonly status: "invalid"; readonly reason: string };

/** Frames from a client must be masked (RFC 6455 §5.1); frames from a server must not be. */
export function decodeFrame(buffer: Buffer, requireMask = true): FrameRead {
  if (buffer.length < 2) return { status: "partial" };
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  if ((first & 0x70) !== 0) return { status: "invalid", reason: "reserved bits set" };

  const opcode = (first & 0x0f) as Opcode;
  if (!Object.values(OPCODE).includes(opcode)) return { status: "invalid", reason: `unknown opcode ${opcode}` };
  const fin = (first & 0x80) !== 0;
  const masked = (second & 0x80) !== 0;
  if (requireMask !== masked) {
    return { status: "invalid", reason: masked ? "masked frame from a server" : "unmasked frame from a client" };
  }

  // Control frames carry a status and a short reason, and are never split across frames.
  const control = (opcode & 0x8) !== 0;
  const short = second & 0x7f;
  if (control && (short > 125 || !fin)) return { status: "invalid", reason: "oversized or fragmented control frame" };

  let offset = 2;
  let length = short;
  if (short === 126) {
    if (buffer.length < offset + 2) return { status: "partial" };
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (short === 127) {
    if (buffer.length < offset + 8) return { status: "partial" };
    const big = buffer.readBigUInt64BE(offset);
    // Node cannot address a buffer that large anyway, and a wake-up is a few dozen bytes.
    if (big > BigInt(MAX_PAYLOAD_BYTES)) return { status: "invalid", reason: "payload too large" };
    length = Number(big);
    offset += 8;
  }
  if (length > MAX_PAYLOAD_BYTES) return { status: "invalid", reason: "payload too large" };

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return { status: "partial" };
  const mask = buffer.subarray(offset, offset + maskLength);
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      // `payload[index] ^= mask[index % 4]`, written so noUncheckedIndexedAccess is satisfied.
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  }
  return { status: "frame", frame: { fin, opcode, payload }, rest: Buffer.from(buffer.subarray(offset + length)) };
}

/**
 * Server frames are never masked, so this is only ever the sending half. It refuses to build
 * what the other side of this file would refuse to read, because emitting a frame a conforming
 * peer has to close the connection over is a bug worth failing on rather than shipping.
 */
export function encodeFrame(opcode: Opcode, payload: Buffer, fin = true): Buffer {
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`websocket payload of ${payload.length} bytes exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`);
  }
  const header: number[] = [(fin ? 0x80 : 0) | opcode];
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65_536) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    const length = BigInt(payload.length);
    header.push(127);
    for (let shift = 56n; shift >= 0n; shift -= 8n) header.push(Number((length >> shift) & 0xffn));
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

export function encodeText(text: string): Buffer {
  return encodeFrame(OPCODE.text, Buffer.from(text, "utf8"));
}

/** A close frame carries a two-byte status ahead of its reason. */
export function encodeClose(code: number, reason = ""): Buffer {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2, "utf8");
  return encodeFrame(OPCODE.close, payload);
}

/**
 * The largest frame this will read. The socket carries whole sync sessions, so a push can be
 * as big as one over HTTP, and both cap at the same 8MB `MAX_BODY_BYTES` for the same reason.
 * A peer must not be able to make the server hold an unbounded amount of a message it has not
 * finished sending.
 */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  tooLarge: 1009,
  internal: 1011,
} as const;
