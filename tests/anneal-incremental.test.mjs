// The annealer evaluates a move incrementally: only the rewired gate's fan-out, stopping
// where a value does not change, rejecting at the first wrong output, and on wide tables
// first trying the move on a sample of rows. None of that may change a single decision.
// Given the same netlist, table, seed and step count it must return exactly what the
// full-recomputation annealer (kept verbatim in anneal-reference.mjs) returns.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anneal } from "../src/anneal.mjs";
import { createRng } from "../src/rng.mjs";
import { synthesize } from "../src/synth.mjs";
import { TABLES } from "../tools/bench.mjs";
import { anneal as reference } from "./anneal-reference.mjs";

function netFor(name) {
  const table = TABLES[name]();
  const s = synthesize({ nIn: table.nIn, ys: table.ys, nOutputs: table.nOut }, { rng: createRng(7) });
  return { table, net: { nIn: table.nIn, gates: s.gates, outputs: s.outputs, nOut: table.nOut } };
}

// Narrow tables exercise fan-out propagation and early rejection; mul6 has 12 input bits,
// wide enough (128 words a signal) that the sampled first look is used as well.
const CASES = [
  ["majority3", 3000],
  ["parity8", 3000],
  ["adder4", 3000],
  ["mul4", 3000],
  ["rand8x8", 3000],
  ["mul6", 1500],
];

for (const [name, steps] of CASES) {
  for (const objective of ["gates", "C"]) {
    test(`incremental annealing is identical to full recomputation: ${name}, ${objective}`, () => {
      const { table, net } = netFor(name);
      const a = reference(net, table.ys, { steps, seed: 11, objective });
      const b = anneal(net, table.ys, { steps, seed: 11, objective });
      assert.deepEqual(b.gates, a.gates);
      assert.deepEqual(b.outputs, a.outputs);
      assert.deepEqual(b.stats, a.stats);
      assert.equal(b.total, a.total);
    });
  }
}
