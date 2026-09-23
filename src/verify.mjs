// Exhaustive verification: evaluate a NAND/LATCH circuit on every
// (input, state) combination and compare it with the table it was compiled
// from. Rows are packed LSB first: row = inputs | state << nIn, and the value
// is outputs | nextState << nOut. At most 20 bits of (input, state), so this
// is always the whole space, never a sample.
//
// Two evaluators that share no code: a bit-sliced one (32 rows per machine
// word, in chunks) covers every row; simulate() from netlist.mjs re-checks
// every row as well when the table is small enough to do that quickly.
import { OPCODE, simulate } from "./netlist.mjs";

export const MAX_BITS = 20;
const CHUNK_ROWS = 8192;
const SIMULATE_LIMIT = 4096;

function shape(circuit) {
  if (circuit.elements.some((e) => e.op === OPCODE.REF)) throw new Error("REF elements are not supported");
  const latches = circuit.elements.filter((e) => e.op === OPCODE.LATCH);
  const bits = circuit.nIn + latches.length;
  if (bits > MAX_BITS) throw new Error(`${bits} bits of (input, state) is too wide to check exhaustively (max ${MAX_BITS})`);
  if (circuit.nOut + latches.length > 32) throw new Error("more than 32 outputs plus state bits");
  return { latches, rows: 2 ** bits };
}

// The complete table a circuit computes, by bit-sliced evaluation.
export function evaluateTable(circuit) {
  const { latches, rows } = shape(circuit);
  const { nIn } = circuit;
  const signalCount = 2 + nIn + circuit.elements.length;
  const ys = new Uint32Array(rows);
  for (let base = 0; base < rows; base += CHUNK_ROWS) {
    const n = Math.min(CHUNK_ROWS, rows - base);
    const W = Math.ceil(n / 32);
    const plane = (bit) => {
      const p = new Uint32Array(W);
      for (let j = 0; j < n; j++) if (((base + j) >>> bit) & 1) p[j >>> 5] |= 1 << (j & 31);
      return p;
    };
    const planes = new Array(signalCount);
    planes[0] = new Uint32Array(W);
    planes[1] = new Uint32Array(W).fill(0xffffffff);
    for (let i = 0; i < nIn; i++) planes[2 + i] = plane(i);
    let li = 0;
    for (const e of circuit.elements) if (e.op === OPCODE.LATCH) planes[e.out] = plane(nIn + li++);
    for (const e of circuit.elements) {
      if (e.op !== OPCODE.NAND) continue;
      const a = planes[e.a];
      const b = planes[e.b];
      const o = new Uint32Array(W);
      for (let w = 0; w < W; w++) o[w] = ~(a[w] & b[w]);
      planes[e.out] = o;
    }
    const outs = [...circuit.outputs.map((s) => planes[s]), ...latches.map((l) => planes[l.d])];
    for (let j = 0; j < n; j++) {
      let got = 0;
      for (let k = 0; k < outs.length; k++) got |= ((outs[k][j >>> 5] >>> (j & 31)) & 1) << k;
      ys[base + j] = got >>> 0;
    }
  }
  return ys;
}

function simulatedWrong(circuit, expected, latches, rows) {
  const { nIn, nOut } = circuit;
  let wrong = 0;
  for (let r = 0; r < rows; r++) {
    const inputs = Uint8Array.from({ length: nIn }, (_, i) => (r >>> i) & 1);
    const state = Uint8Array.from({ length: latches.length }, (_, i) => (r >>> (nIn + i)) & 1);
    const { outputs, newState } = simulate(circuit, inputs, state);
    let got = 0;
    for (let k = 0; k < nOut; k++) got |= outputs[k] << k;
    for (let i = 0; i < latches.length; i++) got |= newState[i] << (nOut + i);
    if (got >>> 0 !== expected[r] >>> 0) wrong += 1;
  }
  return wrong;
}

export function checkExhaustive(circuit, expected) {
  const { latches, rows } = shape(circuit);
  if (expected.length !== rows) throw new Error(`expected table has ${expected.length} rows, the circuit has ${rows}`);
  const ys = evaluateTable(circuit);
  let wrong = 0;
  let firstWrong = null;
  for (let r = 0; r < rows; r++) {
    if (ys[r] !== expected[r] >>> 0) {
      wrong += 1;
      firstWrong ??= { row: r, got: ys[r], want: expected[r] >>> 0 };
    }
  }
  const methods = ["bit-sliced evaluation of every row"];
  let simWrong = 0;
  if (rows <= SIMULATE_LIMIT) {
    simWrong = simulatedWrong(circuit, expected, latches, rows);
    methods.push("simulate() on every row");
  }
  return { rows, wrong: Math.max(wrong, simWrong), firstWrong, methods, exact: wrong === 0 && simWrong === 0 };
}
