// The small amount of ABI encoding and decoding the tapeout plan needs, by
// hand so the repository has no dependencies. tests/tapeout.test.mjs checks it
// against an independent encoding.
import { selector } from "./keccak.mjs";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");

export function normalizeAddress(address, what = "address") {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`${what} must be a 0x-prefixed 20-byte hex address, got ${JSON.stringify(address)}`);
  }
  return address.toLowerCase();
}

// A call whose arguments are all static words: address or uintN.
export function encodeCall(signature, args = []) {
  const types = signature.slice(signature.indexOf("(") + 1, -1).split(",").filter(Boolean);
  if (types.length !== args.length) throw new Error(`${signature} takes ${types.length} arguments, got ${args.length}`);
  const words = types.map((type, i) => {
    if (type === "address") return normalizeAddress(args[i]).slice(2).padStart(64, "0");
    const m = /^uint(\d+)$/.exec(type);
    if (!m) throw new Error(`unsupported argument type ${type}`);
    const v = BigInt(args[i]);
    if (v < 0n || v >= 1n << BigInt(m[1])) throw new RangeError(`${args[i]} does not fit in ${type}`);
    return word(v);
  });
  return selector(signature) + words.join("");
}

// tapeout(bytes nl, uint32 nIn, uint32 nOut): head (offset of nl, nIn, nOut),
// then the byte length and the bytes, zero-padded to a whole word.
export function encodeTapeout({ netlistHex, nIn, nOut }) {
  const body = String(netlistHex).replace(/^0x/, "").toLowerCase();
  if (body.length % 2 !== 0 || /[^0-9a-f]/.test(body)) throw new Error("netlistHex must be whole bytes of hex");
  for (const [name, v] of [["nIn", nIn], ["nOut", nOut]]) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`${name} must fit in uint32`);
  }
  const length = body.length / 2;
  const padding = "0".repeat(((32 - (length % 32)) % 32) * 2);
  return selector("tapeout(bytes,uint32,uint32)") + word(0x60) + word(nIn) + word(nOut) + word(length) + body + padding;
}

export function decodeUint(hex) {
  const h = String(hex).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}/.test(h)) throw new Error(`expected a 32-byte return value, got ${JSON.stringify(hex)}`);
  return BigInt(`0x${h.slice(0, 64)}`);
}

export function decodeAddress(hex) {
  const value = decodeUint(hex);
  if (value >> 160n) throw new Error(`return value ${hex} is not an address`);
  return `0x${value.toString(16).padStart(40, "0")}`;
}
