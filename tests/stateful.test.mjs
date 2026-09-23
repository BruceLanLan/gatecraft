import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readNetlist } from "../src/artifacts.mjs";
import { OPCODE } from "../src/netlist.mjs";
import { layout, rebuild } from "../src/rebuild.mjs";
import { unwrap } from "../src/stateful.mjs";
import { checkExhaustive, evaluateTable } from "../src/verify.mjs";
import { delay, toggle, wastefulCounter, wastefulToggle } from "./fixtures/stateful-examples.mjs";
import { runScript, tableOf, tempDir } from "./helpers.mjs";

const FIXTURES = "tests/fixtures/stateful-examples.mjs";

test("unwrapping a stateful circuit keeps its complete (input, state) table", () => {
  for (const make of [delay, toggle, wastefulToggle, wastefulCounter]) {
    const original = make();
    const net = unwrap(original);
    const ys = evaluateTable(original);
    assert.deepEqual([...tableOf({ nIn: net.nIn, nLatch: net.nLatch, gates: net.gates, outputs: net.outputs })], [...ys]);
    // laid out again without annealing: same behaviour, never more NAND than finalize() spent
    const again = rebuild(net);
    assert.equal(checkExhaustive(again, ys).wrong, 0);
    assert.ok(again.nNand <= original.nNand);
    assert.equal(again.nNand, layout({ nIn: net.nIn + net.nLatch, gates: net.gates, outputs: net.outputs, nOut: net.nOut }).total);
  }
});

test("anneal-stateful shrinks a wasteful circuit and proves it on every pair", () => {
  const cases = [
    ["toggle-min", "toggle", 6],
    ["wasteful-toggle-min", "wastefulToggle", 9],
    ["counter-min", "wastefulCounter", wastefulCounter().nNand],
  ];
  for (const [name, exportName, before] of cases) {
    const out = tempDir();
    const r = runScript("scripts/anneal-stateful.mjs", [FIXTURES, exportName, "--name", name, "--steps", "30000", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const cert = JSON.parse(readFileSync(join(out, "circuit.certificate.json"), "utf8"));
    assert.equal(cert.minimisation.nandBefore, before);
    assert.ok(cert.minimisation.nandAfter < before, `${name}: ${cert.minimisation.nandAfter} is not below ${before}`);
    assert.equal(cert.circuit.nand, cert.minimisation.nandAfter);
    const { circuit } = readNetlist(join(out, "circuit.netlist.json"));
    assert.equal(circuit.nNand, cert.circuit.nand, "the certificate counts the NANDs actually emitted");
    assert.equal(circuit.elements.filter((e) => e.op === OPCODE.LATCH).length, cert.minimisation.latch);
    const original = { toggle, wastefulToggle, wastefulCounter }[exportName]();
    assert.equal(checkExhaustive(circuit, evaluateTable(original)).wrong, 0);
  }
});

test("anneal-stateful refuses a circuit it cannot make smaller and writes nothing", () => {
  const dir = tempDir();
  const out = join(dir, "never");
  const r = runScript("scripts/anneal-stateful.mjs", [FIXTURES, "delay", "--name", "delay-min", "--steps", "30000", "--out", out]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not smaller \(2 NAND before, 2 after, 1 LATCH either way\)/);
  assert.equal(existsSync(out), false);
});

test("anneal-stateful gives the same netlist for the same seed", () => {
  const runOnce = () => {
    const out = tempDir();
    const r = runScript("scripts/anneal-stateful.mjs", [FIXTURES, "wastefulCounter", "--name", "counter-min", "--steps", "10000", "--seed", "99", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(join(out, "circuit.netlist.json"), "utf8")).netlistHex;
  };
  assert.equal(runOnce(), runOnce());
});

test("compile-fsm CLI compiles a counter and reports reachable states", () => {
  const out = tempDir();
  const r = runScript("scripts/compile-fsm.mjs", ["--fn", "[x && s === 3 ? 1 : 0, x ? (s + 1) % 4 : s]", "--nIn", "1", "--nState", "2", "--nOut", "1", "--name", "counter", "--steps", "20000", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const cert = JSON.parse(readFileSync(join(out, "circuit.certificate.json"), "utf8"));
  assert.equal(cert.circuit.latch, 2);
  assert.equal(cert.verification.rowsChecked, 8);
  assert.equal(cert.stateMachine.reachableFromStart, 4);
  const { circuit } = readNetlist(join(out, "circuit.netlist.json"));
  const table = JSON.parse(readFileSync(join(out, "table.json"), "utf8"));
  assert.equal(checkExhaustive(circuit, Uint32Array.from(table.ys)).wrong, 0);
});

test("compile-fsm reports states that can never be reached", () => {
  const out = tempDir();
  // a 2-bit state that only ever moves between 0 and 1
  const r = runScript("scripts/compile-fsm.mjs", ["--fn", "[s & 1, x ? (s ^ 1) & 1 : s & 1]", "--nIn", "1", "--nState", "2", "--nOut", "1", "--name", "blinker", "--steps", "5000", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const cert = JSON.parse(readFileSync(join(out, "circuit.certificate.json"), "utf8"));
  assert.equal(cert.stateMachine.reachableFromStart, 2);
  assert.equal(cert.stateMachine.unreachableStates, 2);
});
