// Checking a taped-out circuit against the chain that holds it, read-only.
//
// A circuit on TapeOut is not only stored, it can be RUN on chain: the circuits contract
// answers `circuitInfo(id)`, `netlist(id)`, `eval(id, inputs)` and `step(id, state, inputs)`
// as view functions. So the promise "the answer in your hand is the answer on chain" is
// checkable by anyone, with no wallet, no signature and nothing spent: read the netlist,
// decode it here, and compare a sample of rows against the chain's own evaluator.
//
// Bits travel packed, least significant bit first, one byte holding eight of them - read off
// the chain by trying both conventions on several rows (2026-09-18: a public 72-gate circuit
// agreed on 24 of 24 sampled rows with the packed convention, and every row of a 3-gate one).
// A chain that changes this will show up as "could not tell how the chain packs its bytes"
// rather than as a wrong answer.
import { normalizeAddress } from "./abi.mjs";
import { selector } from "./keccak.mjs";
import { circuitFromElements, decodeElements, hexToBytes, simulate } from "./netlist.mjs";

export const PACKINGS = {
  // The convention the chain speaks; kept first so it is tried first.
  packed: {
    label: "packed, least significant bit first",
    pack(bits) {
      const bytes = new Uint8Array(Math.ceil(bits.length / 8));
      bits.forEach((bit, i) => { if (bit) bytes[i >> 3] |= 1 << (i & 7); });
      return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    },
    unpack: (hex, count) => {
      const bytes = hex.slice(2).match(/../g) ?? [];
      return Array.from({ length: count }, (_, i) => (Number.parseInt(bytes[i >> 3] ?? "00", 16) >> (i & 7)) & 1);
    },
  },
  byteWise: {
    label: "one byte per bit",
    pack: (bits) => `0x${bits.map((bit) => (bit ? "01" : "00")).join("")}`,
    unpack: (hex, count) => {
      const bytes = hex.slice(2).match(/../g) ?? [];
      return Array.from({ length: count }, (_, i) => (Number.parseInt(bytes[i] ?? "00", 16) ? 1 : 0));
    },
  },
};

const word = (hex, index) => hex.slice(2 + index * 64, 2 + (index + 1) * 64);
const uint = (hex, index) => Number.parseInt(word(hex, index), 16);
const dynamicBytes = (hex, slot = 0) => {
  const at = Number.parseInt(word(hex, slot), 16) / 32;
  const length = Number.parseInt(word(hex, at), 16);
  return `0x${hex.slice(2 + (at + 1) * 64, 2 + (at + 1) * 64 + length * 2)}`;
};
const bitsOf = (value, width) => Array.from({ length: width }, (_, i) => (value >> i) & 1);

const idWord = (id) => BigInt(id).toString(16).padStart(64, "0");
const callData = (signature, id, ...byteArgs) => {
  const head = [idWord(id)];
  const tails = [];
  let offset = 32 * (1 + byteArgs.length);
  for (const value of byteArgs) {
    const raw = value.slice(2);
    head.push(offset.toString(16).padStart(64, "0"));
    const padded = raw.padEnd(Math.ceil(raw.length / 64) * 64, "0");
    tails.push(`${(raw.length / 2).toString(16).padStart(64, "0")}${padded}`);
    offset += 32 + padded.length / 2;
  }
  return `${selector(signature)}${head.join("")}${tails.join("")}`;
};

// Reads a circuit off the chain: its shape, its bytes, and those bytes decoded here.
export async function readCircuit({ rpcUrl, circuits, id, fetch = globalThis.fetch, timeoutMs = 30_000 }) {
  const to = normalizeAddress(circuits, "circuits");
  let nextId = 1;
  const call = async (data) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    if (body.error) throw new Error(`the chain refused a read: ${body.error.message}`);
    return body.result;
  };
  const info = await call(`${selector("circuitInfo(uint256)")}${idWord(id)}`);
  const shape = { nIn: uint(info, 0), nOut: uint(info, 1), nState: uint(info, 2), gates: uint(info, 3) };
  if (!shape.gates) throw new Error(`circuit #${id} has no gates on this contract; check the address and the id`);
  const netlistHex = dynamicBytes(await call(`${selector("netlist(uint256)")}${idWord(id)}`));
  const circuit = circuitFromElements(decodeElements(hexToBytes(netlistHex), shape.nIn), shape.nIn, shape.nOut);
  return { to, shape, netlistHex, circuit, call };
}

// Compares the chain's own answers with simulate() on a sample of rows. Returns what was
// compared and every row that disagreed; it never writes anything anywhere.
export async function chainCheck({ rpcUrl, circuits, id, rows = 24, netlistHex = null, fetch = globalThis.fetch, timeoutMs = 30_000 }) {
  const read = await readCircuit({ rpcUrl, circuits, id, fetch, timeoutMs });
  const { shape, circuit, call } = read;
  const total = 2 ** (shape.nIn + circuit.nLatch);
  const count = Math.min(rows, total);
  const picked = Array.from({ length: count }, (_, i) => (total <= count ? i : Math.floor((i * total) / count)));

  const ask = async (packing, row) => {
    const inputs = bitsOf(row % 2 ** shape.nIn, shape.nIn);
    const state = bitsOf(Math.floor(row / 2 ** shape.nIn), circuit.nLatch);
    const mine = simulate(circuit, inputs, Uint8Array.from(state));
    const answer = circuit.nLatch
      ? await call(callData("step(uint256,bytes,bytes)", id, packing.pack(state), packing.pack(inputs)))
      : await call(callData("eval(uint256,bytes)", id, packing.pack(inputs)));
    const outputs = packing.unpack(circuit.nLatch ? dynamicBytes(answer, 1) : dynamicBytes(answer), shape.nOut);
    const next = circuit.nLatch ? packing.unpack(dynamicBytes(answer, 0), circuit.nLatch) : [];
    return {
      row,
      inputs,
      state,
      chain: { outputs, next },
      here: { outputs: [...mine.outputs], next: [...mine.newState] },
      same: outputs.join("") === [...mine.outputs].join("") && next.join("") === [...mine.newState].join(""),
    };
  };

  // On an all-zero row every packing looks alike, so a candidate must match several rows.
  const probe = picked.slice(0, Math.min(6, picked.length));
  let packing = null;
  for (const candidate of Object.values(PACKINGS)) {
    let agreed = 0;
    for (const row of probe) {
      let outcome;
      try {
        outcome = await ask(candidate, row);
      } catch {
        break;
      }
      if (!outcome.same) break;
      agreed += 1;
    }
    if (agreed === probe.length) {
      packing = candidate;
      break;
    }
  }
  const base = {
    contract: read.to,
    id: String(id),
    shape,
    netlistHex: read.netlistHex,
    netlistBytes: (read.netlistHex.length - 2) / 2,
    nand: circuit.nNand,
    latch: circuit.nLatch,
    rowsTotal: total,
    matchesGiven: netlistHex ? netlistHex.toLowerCase() === read.netlistHex.toLowerCase() : null,
  };
  if (!packing) {
    return { ...base, agreed: false, packing: null, rowsChecked: 0, wrong: [], reason: "could not tell how the chain packs its bytes, so nothing was compared" };
  }
  const results = [];
  for (const row of picked) results.push(await ask(packing, row));
  const wrong = results.filter((r) => !r.same);
  return { ...base, packing: packing.label, rowsChecked: results.length, wrong, agreed: wrong.length === 0 };
}
