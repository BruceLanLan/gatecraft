import { test } from "node:test";
import assert from "node:assert/strict";
import { layout, rebuild } from "../src/rebuild.mjs";
import { checkExhaustive } from "../src/verify.mjs";
import { createRng, parseSeed, seedFromDigest } from "../src/rng.mjs";
import { OPCODE } from "../src/netlist.mjs";
import { tableOf } from "./helpers.mjs";

function assertRebuilt(net) {
  const circuit = rebuild(net);
  const nand = circuit.elements.filter((e) => e.op === OPCODE.NAND).length;
  assert.equal(nand, layout(net).total, "rebuilt size must equal the layout yardstick");
  const check = checkExhaustive(circuit, tableOf(net));
  assert.equal(check.wrong, 0, JSON.stringify(check.firstWrong));
  const nOut = net.outputs.length - (net.nLatch ?? 0);
  circuit.outputs.forEach((s, k) => assert.equal(s, circuit.signalCount - nOut + k));
  return circuit;
}

test("an output gate read by a later gate does not break the rebuild", () => {
  // gate 4 is an output and is read by gate 5, which feeds output gate 6
  const net = { nIn: 2, gates: [[2, 3], [4, 3], [5, 2]], outputs: [4, 6] };
  const c = assertRebuilt(net);
  assert.equal(c.layout.bufferedOutputs, 1);
});

test("constants, inputs and repeated outputs are copied to the tail", () => {
  const net = { nIn: 2, gates: [[2, 3]], outputs: [0, 1, 2, 4, 4] };
  const c = assertRebuilt(net);
  assert.equal(c.layout.bufferedOutputs, 5);
  assert.equal(c.nNand, 1 + 10);
});

test("a gate nothing else reads is emitted last without buffers", () => {
  const net = { nIn: 3, gates: [[2, 3], [5, 4], [6, 6]], outputs: [7] };
  const c = assertRebuilt(net);
  assert.equal(c.nNand, 3);
  assert.equal(c.layout.bufferedOutputs, 0);
});

function randomNet(rng, { stateful }) {
  const nIn = stateful ? Math.floor(rng() * 4) : 1 + Math.floor(rng() * 5);
  const nLatch = stateful ? 1 + Math.floor(rng() * 3) : 0;
  const gate0 = 2 + nIn + nLatch;
  const gates = [];
  const nGates = Math.floor(rng() * 14);
  for (let i = 0; i < nGates; i++) gates.push([Math.floor(rng() * (gate0 + i)), Math.floor(rng() * (gate0 + i))]);
  const nOut = 1 + Math.floor(rng() * 4);
  const outputs = Array.from({ length: nOut + nLatch }, () => Math.floor(rng() * (gate0 + nGates)));
  return { nIn, nLatch, gates, outputs };
}

test("random combinational netlists rebuild exactly and at the layout size", () => {
  const rng = createRng(1);
  for (let i = 0; i < 400; i++) assertRebuilt(randomNet(rng, { stateful: false }));
});

test("random stateful netlists rebuild exactly on every (input, state) pair", () => {
  const rng = createRng(2);
  for (let i = 0; i < 400; i++) {
    const net = randomNet(rng, { stateful: true });
    const c = assertRebuilt(net);
    assert.equal(c.nLatch, net.nLatch);
  }
});

test("the seeded generator repeats exactly and seeds parse strictly", () => {
  const a = createRng(42), b = createRng(42), c = createRng(43);
  const sa = Array.from({ length: 5 }, a), sb = Array.from({ length: 5 }, b), sc = Array.from({ length: 5 }, c);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.ok(sa.every((v) => v >= 0 && v < 1));
  assert.equal(parseSeed("7"), 7);
  assert.equal(parseSeed("0xff"), 255);
  assert.throws(() => parseSeed("-1"));
  assert.throws(() => parseSeed("1.5"));
  assert.equal(seedFromDigest("0000002a" + "0".repeat(56)), 42);
});
