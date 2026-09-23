// Turning what a person writes into the complete table compileTable() needs.
//
//   combinational  { nIn, nOut, rows: [[x, y], ...] }  or  { nIn, nOut, fn: "<expression in x>" }
//   grid           { map: 16x16 of 0..3 }  or  { fn: "<expression in x, y>" }
//                  two 4-bit inputs X (bits 0-3) and Y (bits 4-7), a 2-bit choice out
//   state machine  { nIn, nState, nOut, rows: [[x, s, y, next], ...] }
//                  or { nIn, nState, nOut, fn: "<expression in x, s returning [y, next]>" }
//
// Every form lists or generates every row; nothing is filled in by default.

function evaluator(source, params) {
  if (typeof source !== "string" || !source.trim()) throw new Error("fn must be a non-empty expression");
  try {
    return new Function(...params, `"use strict"; return (${source});`);
  } catch (error) {
    throw new Error(`cannot parse fn: ${error.message}`);
  }
}

function fits(value, bits, where) {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
    throw new Error(`${where} is ${JSON.stringify(value)}, which is not an integer in 0..${2 ** bits - 1}`);
  }
  return value;
}

const count = (value, what) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${what} must be a non-negative integer`);
  return value;
};

export function combinationalTable(spec) {
  const nIn = count(spec.nIn, "nIn");
  const nOut = count(spec.nOut, "nOut");
  if (nIn < 1 || nIn > 20) throw new Error("nIn must be 1..20");
  if (nOut < 1 || nOut > 32) throw new Error("nOut must be 1..32");
  const ys = new Uint32Array(2 ** nIn);
  if (spec.rows) {
    if (spec.rows.length !== ys.length) throw new Error(`rows must list all ${ys.length} inputs, got ${spec.rows.length}`);
    const seen = new Uint8Array(ys.length);
    for (const [x, y] of spec.rows) {
      fits(x, nIn, "a row input");
      if (seen[x]++) throw new Error(`input ${x} is listed twice`);
      ys[x] = fits(y, nOut, `the output for input ${x}`);
    }
  } else if (spec.fn !== undefined) {
    const f = evaluator(spec.fn, ["x"]);
    for (let x = 0; x < ys.length; x++) ys[x] = fits(Number(f(x)), nOut, `fn(${x})`);
  } else {
    throw new Error("a table needs rows or fn");
  }
  return { nIn, nState: 0, nOut, ys };
}

export function gridTable(spec) {
  const ys = new Uint32Array(256);
  if (spec.map) {
    const map = spec.map;
    if (!Array.isArray(map) || map.length !== 16 || map.some((row) => !Array.isArray(row) || row.length !== 16)) {
      throw new Error("map must be a 16x16 array: rows are X = 0..15, columns are Y = 0..15");
    }
    for (let x = 0; x < 256; x++) ys[x] = fits(map[x & 15][x >> 4], 2, `map[${x & 15}][${x >> 4}]`);
  } else if (spec.fn !== undefined) {
    const f = evaluator(spec.fn, ["x", "y"]);
    for (let x = 0; x < 256; x++) ys[x] = fits(Number(f(x & 15, x >> 4)), 2, `fn(${x & 15}, ${x >> 4})`);
  } else {
    throw new Error("a grid needs map or fn");
  }
  const counts = [0, 0, 0, 0];
  for (const y of ys) counts[y] += 1;
  return { table: { nIn: 8, nState: 0, nOut: 2, ys }, counts };
}

export function fsmTable(spec) {
  const nIn = count(spec.nIn, "nIn");
  const nState = count(spec.nState, "nState");
  const nOut = count(spec.nOut, "nOut");
  if (nState < 1) throw new Error("a state machine needs nState >= 1 (use compile-table for no state)");
  if (nIn + nState > 20) throw new Error(`inputs plus state must be at most 20 bits, got ${nIn + nState}`);
  if (nOut < 1 || nOut + nState > 32) throw new Error("need nOut >= 1 and nOut + nState <= 32");
  const ys = new Uint32Array(2 ** (nIn + nState));
  const pack = (x, s, y, next) => {
    fits(y, nOut, `the output for input ${x} in state ${s}`);
    fits(next, nState, `the next state for input ${x} in state ${s}`);
    return (y + next * 2 ** nOut) >>> 0;
  };
  if (spec.rows) {
    if (spec.rows.length !== ys.length) throw new Error(`rows must list every (input, state) pair: ${ys.length} rows, got ${spec.rows.length}`);
    const seen = new Uint8Array(ys.length);
    for (const [x, s, y, next] of spec.rows) {
      fits(x, nIn, "a row input");
      fits(s, nState, "a row state");
      const r = x + s * 2 ** nIn;
      if (seen[r]++) throw new Error(`input ${x} in state ${s} is listed twice`);
      ys[r] = pack(x, s, y, next);
    }
  } else if (spec.fn !== undefined) {
    const f = evaluator(spec.fn, ["x", "s"]);
    for (let s = 0; s < 2 ** nState; s++) {
      for (let x = 0; x < 2 ** nIn; x++) {
        const v = f(x, s);
        if (!Array.isArray(v) || v.length !== 2) throw new Error(`fn(${x}, ${s}) must return [output, nextState]`);
        ys[x + s * 2 ** nIn] = pack(x, s, Number(v[0]), Number(v[1]));
      }
    }
  } else {
    throw new Error("a state machine needs rows or fn");
  }
  return { nIn, nState, nOut, ys };
}

// States reachable from the power-on state 0 under any input sequence.
export function reachableStates({ nIn, nState, nOut, ys }) {
  const seen = new Uint8Array(2 ** nState);
  const queue = [0];
  seen[0] = 1;
  while (queue.length) {
    const s = queue.shift();
    for (let x = 0; x < 2 ** nIn; x++) {
      const next = Math.floor(ys[x + s * 2 ** nIn] / 2 ** nOut);
      if (!seen[next]) {
        seen[next] = 1;
        queue.push(next);
      }
    }
  }
  return [...seen.keys()].filter((s) => seen[s]);
}
