import { test } from "node:test";
import assert from "node:assert/strict";
import { Bdd, synthesize } from "../src/synth.mjs";
import { createRng } from "../src/rng.mjs";
import { combinationalTable } from "../src/tables.mjs";
import { tableOf } from "./helpers.mjs";

const evaluate = ({ nodes, roots }, row) => roots.reduce((y, root, k) => {
  let id = root;
  while (id >= 0) {
    const [v, lo, hi] = nodes[id];
    id = (row >>> v) & 1 ? hi : lo;
  }
  return y | ((id === -2 ? 1 : 0) << k);
}, 0) >>> 0;

function shuffled(n, rng) {
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

test("sifting keeps every output's function, keeps the diagram ordered and never grows it", () => {
  const rng = createRng(11);
  for (let i = 0; i < 40; i++) {
    const nIn = 2 + Math.floor(rng() * 9);
    const nOutputs = 1 + Math.floor(rng() * 4);
    const structured = rng() < 0.5;
    const ys = Uint32Array.from({ length: 2 ** nIn }, (_, x) => (structured ? ((x & 15) + (x >> 4)) % 2 ** nOutputs : Math.floor(rng() * 2 ** nOutputs)));
    const bdd = new Bdd(nIn, ys, nOutputs, shuffled(nIn, rng));
    const before = bdd.size;
    bdd.sift();
    const diagram = bdd.export();
    assert.ok(diagram.nodes.length <= before, `table ${i} grew from ${before} to ${diagram.nodes.length}`);
    assert.equal(diagram.nodes.length, bdd.size, "reference counts agree with what is reachable");
    const level = new Map(diagram.order.map((v, l) => [v, l]));
    for (const [v, lo, hi] of diagram.nodes) {
      for (const child of [lo, hi]) if (child >= 0) assert.ok(level.get(diagram.nodes[child][0]) > level.get(v), "children sit below their parent");
    }
    for (let x = 0; x < ys.length; x++) assert.equal(evaluate(diagram, x), ys[x], `table ${i}, row ${x}`);
  }
});

test("sifting finds a small order for an adder whose natural order is exponential", () => {
  const table = combinationalTable({ nIn: 16, nOut: 9, fn: "(x&255)+((x>>8)&255)" });
  const plain = synthesize({ nIn: 16, ys: table.ys, nOutputs: 9 }, { rng: createRng(1), sift: false });
  const sifted = synthesize({ nIn: 16, ys: table.ys, nOutputs: 9 }, { rng: createRng(1) });
  assert.equal(sifted.sifted, true);
  assert.ok(sifted.gates.length * 2 < plain.gates.length, `sifted ${sifted.gates.length} NAND, plain orders ${plain.gates.length}`);
  assert.deepEqual(tableOf({ nIn: 16, gates: sifted.gates, outputs: sifted.outputs }), table.ys);
});

test("synthesis never emits more gates with sifting than without", () => {
  const rng = createRng(5);
  const tables = [
    combinationalTable({ nIn: 12, nOut: 1, fn: "(x >> ((x >> 8) & 7)) & 1" }),
    ...Array.from({ length: 12 }, () => {
      const nIn = 3 + Math.floor(rng() * 8);
      const nOut = 1 + Math.floor(rng() * 3);
      return { nIn, nOut, ys: Uint32Array.from({ length: 2 ** nIn }, () => Math.floor(rng() * 2 ** nOut)) };
    }),
  ];
  for (const table of tables) {
    const without = synthesize({ nIn: table.nIn, ys: table.ys, nOutputs: table.nOut }, { rng: createRng(3), sift: false });
    const withSift = synthesize({ nIn: table.nIn, ys: table.ys, nOutputs: table.nOut }, { rng: createRng(3) });
    assert.ok(withSift.gates.length <= without.gates.length, `${withSift.gates.length} > ${without.gates.length}`);
    assert.deepEqual(tableOf({ nIn: table.nIn, gates: withSift.gates, outputs: withSift.outputs }), table.ys);
  }
});

test("a swap that grows the node arrays keeps rewriting the live ones, not a stale copy", () => {
  // A 17-bit adder with the 8-bit operand declared first: its diagram crosses the capacity
  // boundary in the middle of the first swap. Before the fix the rewritten nodes went into
  // arrays nothing read any more, the diagram came out with a cycle, and export() recursed
  // until the stack ran out. Every reachable node must still obey the order and be in its
  // unique table after each swap, and the diagram must still compute the table.
  const nIn = 17;
  const ys = new Uint32Array(2 ** nIn);
  for (let row = 0; row < ys.length; row++) ys[row] = ((row & 0xff) + (row >>> 8)) & 0x3ff;
  const bdd = new Bdd(nIn, ys, 10, [...Array(nIn).keys()]);
  const cap = bdd.cap;
  const invariants = (tag) => {
    const seen = new Set();
    const stack = [...bdd.roots];
    while (stack.length) {
      const id = stack.pop();
      if (id < 0 || seen.has(id)) continue;
      seen.add(id);
      for (const child of [bdd.LO[id], bdd.HI[id]]) {
        if (child < 0) continue;
        assert.ok(bdd.levelOf[bdd.V[child]] > bdd.levelOf[bdd.V[id]], `${tag}: node ${id} has a child above it`);
        assert.ok(bdd.REF[child] > 0, `${tag}: node ${id} points at a freed node`);
        stack.push(child);
      }
    }
  };
  bdd.swap(8);
  assert.ok(bdd.cap > cap, "the first swap really does grow the arrays, or this test checks nothing");
  invariants("after the growing swap");
  bdd.sift();
  invariants("after sifting");
  const out = bdd.export();
  for (let row = 0; row < ys.length; row += 97) assert.equal(evaluate(out, row), ys[row], `row ${row}`);
});
