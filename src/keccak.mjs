// keccak256 in plain JavaScript, so the repository needs no dependencies.
// A hand-rolled hash is exactly the kind of thing not to trust, so selector()
// is checked when this module loads against selectors that are fixed by
// public interfaces, and tests/tapeout.test.mjs checks the published keccak256
// test vectors.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// rho offsets, lane index = x + 5y
const R = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M = (1n << 64n) - 1n;
const rotl = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M;

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    const D = new Array(5);
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D[x];
    const Bl = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      Bl[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], R[x + 5 * y]);
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      A[x + 5 * y] = Bl[x + 5 * y] ^ (~Bl[(x + 1) % 5 + 5 * y] & M & Bl[(x + 2) % 5 + 5 * y]);
    }
    A[0] ^= RC[round];
  }
  return A;
}

export function keccak256(bytes) {
  const RATE = 136;                                       // 1088 bits
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] |= 0x01;                           // original Keccak padding, not SHA3's 0x06
  padded[padded.length - 1] |= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

const hex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const selector = (sig) => hex(keccak256(new TextEncoder().encode(sig))).slice(0, 10);

// Selectors fixed by public interfaces: ERC-173 owner(), ERC-721
// ownerOf(uint256), and the TapeOut processor functions.
const VECTORS = [
  ["tapeout(bytes,uint32,uint32)", "0x7bd3ac1d"],
  ["nextId()", "0x61b8ce8c"],
  ["owner()", "0x8da5cb5b"],
  ["ownerOf(uint256)", "0x6352211e"],
  ["circuitInfo(uint256)", "0x084d60f1"],
];
for (const [sig, want] of VECTORS) {
  const got = selector(sig);
  if (got !== want) throw new Error(`keccak256 is wrong: ${sig} -> ${got}, expected ${want}`);
}
