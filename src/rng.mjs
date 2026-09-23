// Seeded pseudo-random numbers (mulberry32). Every random choice the compiler
// makes draws from one of these, so the same table and the same seed always
// give the same netlist. Not suitable for anything secret.

export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseSeed(value) {
  const text = String(value).trim();
  if (/^(0|[1-9][0-9]*)$/.test(text) && Number(text) <= 0xffffffff) return Number(text) >>> 0;
  if (/^0x[0-9a-f]{1,8}$/i.test(text)) return Number.parseInt(text.slice(2), 16) >>> 0;
  throw new Error(`seed must be an integer 0..4294967295 or 0x-prefixed hex, got "${value}"`);
}

// Default seed for a table: the first 32 bits of its SHA-256, so compiling the
// same table twice gives the same circuit without passing a seed at all.
export function seedFromDigest(sha256Hex) {
  if (!/^[0-9a-f]{8}/i.test(sha256Hex)) throw new Error("expected a hex SHA-256 digest");
  return Number.parseInt(sha256Hex.slice(0, 8), 16) >>> 0;
}
