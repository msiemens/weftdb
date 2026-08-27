/**
 * SHA-256, computed synchronously.
 *
 * `stableHash` runs inside the relay's `validateTxn`, which is synchronous, and the snapshot digest
 * inside `contentAddressSnapshot`, which is too. The Web Crypto API answers a digest with a promise
 * and has no synchronous form, so it cannot be called from either.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

export function sha256Hex(input: string): string {
  const blocks = paddedBlocks(new TextEncoder().encode(input));
  const schedule = new Uint32Array(64);
  // The eight words of state are locals rather than array elements, because reading state out
  // of an array costs more per block than the compression does, and destructuring it would cost
  // more still by building an iterator. This loop runs once per 64 bytes of everything the
  // protocol hashes.
  let hash0 = 0x6a09e667;
  let hash1 = 0xbb67ae85;
  let hash2 = 0x3c6ef372;
  let hash3 = 0xa54ff53a;
  let hash4 = 0x510e527f;
  let hash5 = 0x9b05688c;
  let hash6 = 0x1f83d9ab;
  let hash7 = 0x5be0cd19;

  for (let offset = 0; offset < blocks.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      schedule[index] =
        ((blocks[at] ?? 0) << 24) |
        ((blocks[at + 1] ?? 0) << 16) |
        ((blocks[at + 2] ?? 0) << 8) |
        (blocks[at + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = schedule[index - 15] ?? 0;
      const ahead = schedule[index - 2] ?? 0;
      const s0 = ((previous >>> 7) | (previous << 25)) ^ ((previous >>> 18) | (previous << 14)) ^ (previous >>> 3);
      const s1 = ((ahead >>> 17) | (ahead << 15)) ^ ((ahead >>> 19) | (ahead << 13)) ^ (ahead >>> 10);
      schedule[index] = ((schedule[index - 16] ?? 0) + s0 + (schedule[index - 7] ?? 0) + s1) >>> 0;
    }

    let a = hash0;
    let b = hash1;
    let c = hash2;
    let d = hash3;
    let e = hash4;
    let f = hash5;
    let g = hash6;
    let h = hash7;
    for (let index = 0; index < 64; index += 1) {
      // Rotations are written out rather than called, because the compression function is the
      // whole cost of a hash, and each round has six of them.
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + (K[index] ?? 0) + (schedule[index] ?? 0)) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash0 = (hash0 + a) >>> 0;
    hash1 = (hash1 + b) >>> 0;
    hash2 = (hash2 + c) >>> 0;
    hash3 = (hash3 + d) >>> 0;
    hash4 = (hash4 + e) >>> 0;
    hash5 = (hash5 + f) >>> 0;
    hash6 = (hash6 + g) >>> 0;
    hash7 = (hash7 + h) >>> 0;
  }

  return word(hash0) + word(hash1) + word(hash2) + word(hash3) + word(hash4) + word(hash5) + word(hash6) + word(hash7);
}

function word(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/** The message, a 1 bit, zeroes, and the bit length as a big-endian 64-bit integer. */
function paddedBlocks(message: Uint8Array): Uint8Array {
  const length = message.length;
  const padded = new Uint8Array((Math.floor((length + 8) / 64) + 1) * 64);
  padded.set(message);
  padded[length] = 0x80;
  const bits = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000), false);
  view.setUint32(padded.length - 4, bits >>> 0, false);
  return padded;
}
