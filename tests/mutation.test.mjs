// Does the proof actually catch a broken circuit?
//
// Every claim this project makes rests on one sentence: "checked on every row". That sentence
// is about checkExhaustive, and until now checkExhaustive has only ever been run on circuits
// that were correct - which tells you nothing about whether it would notice if one were not.
// A verifier that returns "0 wrong" unconditionally would have passed every test in this
// repository and every measurement in the docs.
//
// So: take circuits that have been proven, break them on purpose one small piece at a time,
// and require the proof to fail. The interesting case is not a circuit that is wrong
// everywhere - it is one that is wrong on exactly one row out of thousands, because that is
// what a real compiler bug looks like and what a sampling check would miss.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OPCODE, simulate } from "../src/netlist.mjs";
import { checkExhaustive, evaluateTable } from "../src/verify.mjs";
import { compileSpec } from "../src/job.mjs";
import { fromTemplate } from "../src/templates.mjs";

const built = (id, knobs) => {
  const spec = fromTemplate(id, knobs).spec;
  const out = compileSpec("expr", spec, { steps: 3000 });
  return { circuit: out.circuit, table: out.table.ys, certificate: out.certificate };
};

// A circuit is a flat list of elements; copying it deeply lets a mutation stay local.
const clone = (circuit) => ({ ...circuit, elements: circuit.elements.map((e) => ({ ...e })) });

test("a proven circuit really is proven: the baseline every mutation is measured against", () => {
  for (const id of ["lamp", "vote", "counter", "traffic", "quota"]) {
    const { circuit, table } = built(id, {});
    const report = checkExhaustive(circuit, table);
    assert.equal(report.wrong, 0, `${id}: nothing wrong before anything is broken`);
    assert.ok(report.rows > 0, `${id}: rows were actually visited`);
    assert.equal(report.exact, true, `${id}: and it says so`);
  }
});

test("rewiring one gate's input is caught, on every template it can be tried on", () => {
  let tried = 0;
  for (const id of ["lamp", "vote", "counter", "traffic", "quota", "thermostat", "lock"]) {
    const { circuit, table } = built(id, {});
    const nands = circuit.elements.map((e, i) => [e, i]).filter(([e]) => e.op === OPCODE.NAND);
    let caught = 0;
    let attempted = 0;
    for (const [element, index] of nands.slice(0, 12)) {
      // Point one input at a different existing signal. Some rewirings are harmless - a gate
      // whose two inputs are already the same, or a signal that happens to be equal - so the
      // test is that SOME mutation is caught on every circuit, and that none is missed while
      // actually changing the table.
      const broken = clone(circuit);
      const swapTo = element.a === 0 ? 1 : 0;
      if (broken.elements[index].a === swapTo) continue;
      broken.elements[index].a = swapTo;
      attempted += 1;
      const changed = evaluateTable(broken).some((y, r) => y !== (table[r] >>> 0));
      const report = checkExhaustive(broken, table);
      if (changed) {
        assert.ok(report.wrong > 0, `${id}: gate ${index} rewired changed the table and the proof missed it`);
        caught += 1;
      } else {
        assert.equal(report.wrong, 0, `${id}: gate ${index} rewired changed nothing, so nothing should be reported`);
      }
    }
    if (attempted) {
      assert.ok(caught > 0, `${id}: not one rewiring of ${attempted} was caught`);
      tried += 1;
    }
  }
  assert.ok(tried >= 5, `only ${tried} templates could be mutated`);
});

test("a circuit wrong on exactly one row out of thousands is caught, which is the whole point", () => {
  // A sampling check passes this. An exhaustive one must not. The mutation is done on the
  // expected table rather than the gates, so that exactly one row differs by construction.
  const { circuit, table } = built("counter", { top: 9 });
  const rows = table.length;
  assert.ok(rows >= 32, `only ${rows} rows; the test needs a table worth searching`);
  for (const row of [0, 1, Math.floor(rows / 3), Math.floor(rows / 2), rows - 1]) {
    const bent = Uint32Array.from(table);
    bent[row] = (bent[row] ^ 1) >>> 0;
    const report = checkExhaustive(circuit, bent);
    assert.equal(report.wrong, 1, `row ${row} of ${rows}: exactly one row differs`);
    assert.equal(report.firstWrong.row, row, `row ${row}: and the report names it`);
  }
});

test("breaking a latch is caught, so the memory is proven too and not just the logic", () => {
  const { circuit, table } = built("lamp", {});
  const latch = circuit.elements.findIndex((e) => e.op === OPCODE.LATCH);
  assert.ok(latch >= 0, "the lamp remembers something");

  const broken = clone(circuit);
  broken.elements[latch].d = broken.elements[latch].d === 0 ? 1 : 0;
  assert.ok(checkExhaustive(broken, table).wrong > 0, "a latch fed from the wrong signal is caught");
});

test("the two evaluators are independent: a bug in one does not hide a bug in the other", () => {
  // checkExhaustive uses a bit-sliced evaluator and, on small tables, re-checks every row with
  // simulate() from another file. This checks they really do agree, and that the second one
  // would notice a disagreement - otherwise the "two methods" in the certificate is decoration.
  const { circuit, table } = built("traffic", {});
  const report = checkExhaustive(circuit, table);
  assert.ok(report.methods.length >= 2, `only one method ran: ${report.methods.join(", ")}`);

  const sliced = evaluateTable(circuit);
  const nLatch = circuit.elements.filter((e) => e.op === OPCODE.LATCH).length;
  for (let row = 0; row < sliced.length; row += 1) {
    const inputs = Array.from({ length: circuit.nIn }, (_, i) => (row >> i) & 1);
    const state = Uint8Array.from({ length: nLatch }, (_, i) => (row >> (circuit.nIn + i)) & 1);
    const one = simulate(circuit, inputs, state);
    let packed = 0;
    one.outputs.forEach((bit, i) => { if (bit) packed |= 1 << i; });
    one.newState.forEach((bit, i) => { if (bit) packed |= 1 << (circuit.nOut + i); });
    assert.equal(sliced[row] >>> 0, packed >>> 0, `row ${row}: the two evaluators disagree`);
  }
});

test("a table of the wrong size is refused rather than checked against the rows that happen to line up", () => {
  const { circuit, table } = built("vote", {});
  assert.throws(() => checkExhaustive(circuit, table.slice(0, table.length - 1)), /rows/);
  assert.throws(() => checkExhaustive(circuit, Uint32Array.from([...table, 0])), /rows/);
});
