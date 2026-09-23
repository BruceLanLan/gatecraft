// A program wider than one proof, cut into blocks that each get one.
//
// The claims worth testing are the ones the certificate makes: every block is proven on
// every row, the top circuit has no logic, the same table is deployed once, and the linked
// circuit, the replay manifest and the program agree. And the one that would be silently
// wrong: a let that goes negative must never be cut into a wire.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeSpec, crossCheck, linkTop, partition, replayManifest, stepLinked, stepReplay } from "../src/compose.mjs";
import { compileSpec } from "../src/job.mjs";
import { ExprError, parseProgram, runStep } from "../src/expr.mjs";
import { OPCODE, decodeElements, simulate } from "../src/netlist.mjs";

const teams = ["a", "b", "c", "d"];
const press = (given) => ({ ...Object.fromEntries(teams.flatMap((t) => [[`${t}_up`, 0], [`${t}_down`, 0]])), ...given });
// Four teams with 8-bit scores: 8 buttons + 32 bits of state, twice the flat ceiling.
const scoreboard = {
  inputs: Object.fromEntries(teams.flatMap((t) => [[`${t}_up`, 1], [`${t}_down`, 1]])),
  state: Object.fromEntries(teams.map((t) => [t, { width: 8, next: `(${t}_up && ${t} < 200) ? ${t} + 1 : ((${t}_down && ${t} > 0) ? ${t} - 1 : ${t})` }])),
  let: { top_ab: "a > b ? a : b", top_cd: "c > d ? c : d" },
  outputs: { ...Object.fromEntries(teams.map((t) => [`${t}_score`, { width: 8, expr: t }])), leader: { width: 8, expr: "top_ab > top_cd ? top_ab : top_cd" } },
  examples: [
    { given: press({ a_up: 1, a: 5 }), expect: { a_score: 5, leader: 5 }, then: { a: 6 } },
    { given: press({ d_down: 1, a: 5, d: 9 }), expect: { leader: 9 }, then: { d: 8 } },
  ],
};

test("a 40-bit program is refused as one circuit and delivered as blocks", () => {
  assert.throws(() => compileSpec("expr", scoreboard, { steps: 500 }), /add up to 40 bits/);
  const out = composeSpec(scoreboard, { steps: 500 });
  assert.equal(out.certificate.composed, true);
  assert.equal(out.certificate.program.bits, 40);
  for (const b of out.certificate.blocks) {
    assert.equal(b.wrong, 0, `block ${b.index} has wrong rows`);
    assert.equal(b.rowsChecked, 2 ** b.nIn, `block ${b.index} was not checked on every row`);
    assert.ok(b.nIn <= 20);
  }
});

test("the top circuit is latches and REFs only: no logic can hide in the wiring", () => {
  const { top, refs, program } = composeSpec(scoreboard, { steps: 500 });
  assert.equal(top.nNand, 0);
  assert.equal(top.nLatch, 32);
  assert.equal(top.elements.filter((e) => e.op === OPCODE.REF).length, refs.length);
  // Every latch is written by a state block, and the tail of the circuit is the outputs in order.
  const latches = top.elements.filter((e) => e.op === OPCODE.LATCH);
  const stateOutputs = new Set(refs.filter((r) => r.kind === "state").flatMap((r) => r.outputs));
  for (const l of latches) assert.ok(stateOutputs.has(l.d), `latch ${l.out} is fed from signal ${l.d}, not from a state block`);
  const tail = refs.filter((r) => r.kind === "output").flatMap((r) => r.outputs);
  assert.deepEqual(tail, top.outputs);
  assert.equal(tail.length, program.nOut);
});

test("the same function on the same widths is one block, used from every place it is needed", () => {
  const { blocks, refs } = composeSpec(scoreboard, { steps: 500 });
  // Four "next score" rules, four "show the score" outputs and three "larger of two" lets are
  // eleven uses of three functions.
  assert.equal(refs.length, 11);
  assert.equal(blocks.length, 3);
  const uses = blocks.map((b) => refs.filter((r) => r.block === b.index).length).sort((x, y) => x - y);
  assert.deepEqual(uses, [3, 4, 4]);
});

test("linked, replayed and the program itself agree, tick by tick", () => {
  const out = composeSpec(scoreboard, { steps: 500 });
  const { program, top, refs, blocks } = out;
  assert.equal(out.certificate.verification.endToEnd.wrong, 0);
  assert.ok(out.certificate.verification.endToEnd.rows > 4000);
  // Play a few presses through both deliveries and compare with the program's own semantics.
  const number = (bits) => bits.reduce((v, bit, i) => v + (bit ? 2 ** i : 0), 0);
  let state = new Array(32).fill(0);
  let scores = Object.fromEntries(teams.map((t) => [t, 0]));
  const presses = [{ a_up: 1 }, { a_up: 1 }, { b_up: 1 }, { a_down: 1 }, { c_up: 1, d_up: 1 }, { d_up: 1 }];
  for (const p of presses) {
    const given = press(p);
    const inputBits = teams.flatMap((t) => [given[`${t}_up`], given[`${t}_down`]]);
    const linked = stepLinked(top, blocks, inputBits, state);
    const replay = stepReplay(program, refs, blocks, inputBits, state);
    const truth = runStep(program, { ...given, ...scores });
    assert.deepEqual([...linked.newState], replay.newState);
    assert.deepEqual([...linked.outputs], replay.outputs);
    const next = teams.map((t, k) => number([...linked.newState].slice(k * 8, k * 8 + 8)));
    assert.deepEqual(next, teams.map((t) => truth.next[t]));
    assert.equal(number([...linked.outputs].slice(32, 40)), truth.outputs.leader, "the leader is the largest score");
    scores = Object.fromEntries(teams.map((t, k) => [t, next[k]]));
    state = [...linked.newState];
  }
  assert.deepEqual(scores, { a: 1, b: 1, c: 1, d: 2 });
});

test("a let that can go negative is inlined, never cut into a wire", () => {
  // d = a - b ranges over -255..255. As a wire it would be truncated and the sign lost; the
  // partition must keep it inside the block that reads it.
  const spec = {
    inputs: { a: 8, b: 8, c: 8 },
    let: { d: "a - b" },
    outputs: { below: { width: 1, expr: "d < 0" }, gap: { width: 9, expr: "d < 0 ? 0 - d : d" }, other: { width: 8, expr: "c" } },
  };
  const program = parseProgram(spec, { wide: true });
  const plan = partition(program);
  assert.deepEqual(plan.inlined, ["d"]);
  assert.ok(!plan.signals.has("d"));
  const out = composeSpec(spec, { steps: 500 });
  const bits = (v, w) => Array.from({ length: w }, (_, i) => (v >>> i) & 1);
  const got = stepLinked(out.top, out.blocks, [...bits(3, 8), ...bits(10, 8), ...bits(0, 8)], []);
  assert.equal(got.outputs[0], 1, "3 - 10 is below zero");
  assert.equal([...got.outputs].slice(1, 10).reduce((v, bit, i) => v + bit * 2 ** i, 0), 7, "and the gap is 7");
});

test("a name that reads more than one proof can hold is refused by name, with the fix", () => {
  const spec = {
    inputs: { a: 8, b: 8, c: 8 },
    outputs: { sum: { width: 10, expr: "a + b + c" } },
  };
  assert.throws(() => composeSpec(spec, { steps: 100 }), (e) => e instanceof ExprError && /"sum" reads 24 bits \(a, b, c\)/.test(e.message) && /"let"/.test(e.message));
  // Named in two steps, each part fits and the whole composes.
  const split = { ...spec, let: { ab: "a + b" } , outputs: { sum: { width: 10, expr: "ab + c" } } };
  const out = composeSpec(split, { steps: 100 });
  assert.equal(out.blocks.length, 2);
  const bits = (v, w) => Array.from({ length: w }, (_, i) => (v >>> i) & 1);
  const got = stepLinked(out.top, out.blocks, [...bits(200, 8), ...bits(100, 8), ...bits(255, 8)], []);
  assert.equal([...got.outputs].reduce((v, bit, i) => v + bit * 2 ** i, 0), 555);
});

test("linking fills in the processor and circuit ids and nothing else; the bytes decode back with REFs", () => {
  const out = composeSpec(scoreboard, { steps: 500 });
  const cpu = "0x" + "ab".repeat(20);
  const ids = out.blocks.map((b) => 1000 + b.index);
  const linked = linkTop(out.top, { cpu, circuitIds: ids });
  const decoded = decodeElements(linked.netlist, linked.nIn);
  const refs = decoded.filter((e) => e.op === OPCODE.REF);
  assert.equal(refs.length, out.refs.length);
  for (const r of refs) {
    assert.equal(r.cpu.toLowerCase(), cpu);
    assert.ok(ids.includes(Number(r.circuitId)));
  }
  assert.equal(decoded.filter((e) => e.op === OPCODE.NAND).length, 0);
  assert.equal(decoded.filter((e) => e.op === OPCODE.LATCH).length, 32);
  // Linked, it still runs the same way when the ids resolve to the same blocks.
  const byId = new Map(ids.map((id, k) => [id, out.blocks[k].circuit]));
  const zero = new Array(8).fill(0);
  const a = simulate(linked, [1, ...zero.slice(1)], new Uint8Array(32), (_, id) => byId.get(Number(id)));
  assert.equal(a.newState[0], 1, "one press on a_up sets a to 1");
});

test("the replay manifest lists every step in the order the top circuit runs them", () => {
  const out = composeSpec(scoreboard, { steps: 500 });
  const m = replayManifest(out);
  assert.equal(m.steps.length, out.refs.length);
  assert.deepEqual(m.steps.map((s) => s.writes), out.refs.map((r) => r.name));
  assert.deepEqual(m.blocks.map((b) => b.index), out.blocks.map((b) => b.index));
  // Lets come before the states and outputs that read them.
  const at = (name) => m.steps.findIndex((s) => s.writes === name);
  assert.ok(at("top_ab") < at("leader") && at("top_cd") < at("leader"));
});

test("a program that fits in one circuit composes too, and behaves like its flat compile", () => {
  const spec = {
    inputs: { press: 1 },
    state: { count: { width: 4, next: "press ? (count == 9 ? 0 : count + 1) : count" } },
    outputs: { digit: { width: 4, expr: "count" }, last: { width: 1, expr: "count == 9" } },
  };
  const flat = compileSpec("expr", spec, { steps: 500 });
  const out = composeSpec(spec, { steps: 500 });
  assert.equal(out.certificate.verification.endToEnd.exhaustive, true, "5 bits: every row was cross-checked");
  for (let row = 0; row < 32; row++) {
    const inputs = [row & 1];
    const state = Uint8Array.from({ length: 4 }, (_, i) => (row >> (1 + i)) & 1);
    const a = simulate(flat.circuit, inputs, state);
    const b = stepLinked(out.top, out.blocks, inputs, state);
    assert.deepEqual([...b.outputs], [...a.outputs], `row ${row}: outputs`);
    assert.deepEqual([...b.newState], [...a.newState], `row ${row}: next state`);
  }
});

test("a cut let used as a divisor: the wire carries 0 on rows the let can never produce, and nothing depends on them", () => {
  // d = a + 1 is never 0, so b / d is legal; but d's wire is 4 bits wide and carries 0 on
  // unreachable rows. Those rows are filled and counted; every reachable row is exact.
  const spec = { inputs: { a: 3, b: 8 }, let: { d: "a + 1" }, outputs: { q: { width: 8, expr: "b / d" } } };
  const out = composeSpec(spec, { steps: 300 });
  const divide = out.certificate.blocks.find((b) => b.computes.some((c) => c.name === "q"));
  assert.ok(divide.unreachableRowsFilled > 0, "the rows with d = 0 were filled, not thrown");
  assert.equal(out.certificate.verification.endToEnd.exhaustive, true);
  const bits = (v, w) => Array.from({ length: w }, (_, i) => (v >>> i) & 1);
  for (const [a, b] of [[0, 255], [7, 200], [3, 9]]) {
    const got = stepLinked(out.top, out.blocks, [...bits(a, 3), ...bits(b, 8)], []);
    assert.equal([...got.outputs].reduce((v, bit, i) => v + bit * 2 ** i, 0), Math.floor(b / (a + 1)), `${b} / ${a + 1}`);
  }
});

test("the wiring check catches a miswired REF: it is a real check, not a formality", () => {
  const out = composeSpec(scoreboard, { steps: 500 });
  const { program, top, refs, blocks } = out;
  assert.doesNotThrow(() => crossCheck(program, top, refs, blocks, 1));
  // Swap two input signals of the first REF that reads more than one bit.
  const bent = { ...top, elements: top.elements.map((e) => ({ ...e, ...(e.inputs ? { inputs: [...e.inputs] } : {}) })) };
  const ref = bent.elements.find((e) => e.op === OPCODE.REF && e.inputs.length > 1);
  [ref.inputs[0], ref.inputs[ref.inputs.length - 1]] = [ref.inputs[ref.inputs.length - 1], ref.inputs[0]];
  assert.throws(() => crossCheck(program, bent, refs, blocks, 1), /linked circuit disagrees/);
  // And a replay manifest that runs a block on the wrong names: team a's plus and minus
  // swapped. (Swapping the two operands of "larger of a and b" would change nothing, and a
  // mutation that changes nothing is not a test.)
  const wrongRefs = refs.map((r) => ({ ...r, reads: [...r.reads] }));
  const first = wrongRefs.find((r) => r.name === "a");
  assert.deepEqual(first.reads, ["a_up", "a_down", "a"]);
  [first.reads[0], first.reads[1]] = [first.reads[1], first.reads[0]];
  assert.throws(() => crossCheck(program, top, wrongRefs, blocks, 1), /replaying the blocks disagrees/);
});
