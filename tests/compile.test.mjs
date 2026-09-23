import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileTable, tableDigest } from "../src/compile.mjs";
import { readNetlist } from "../src/artifacts.mjs";
import { checkExhaustive } from "../src/verify.mjs";
import { combinationalTable, fsmTable, gridTable, reachableStates } from "../src/tables.mjs";
import { createRng } from "../src/rng.mjs";
import { ROOT, runScript, tempDir } from "./helpers.mjs";

const STEPS = 20_000;

test("majority of three compiles exactly and small", () => {
  const table = combinationalTable({ nIn: 3, nOut: 1, fn: "((x&1)+((x>>1)&1)+((x>>2)&1))>=2?1:0" });
  const { circuit, certificate } = compileTable(table, { steps: STEPS });
  assert.equal(checkExhaustive(circuit, table.ys).wrong, 0);
  assert.equal(certificate.verification.rowsChecked, 8);
  assert.ok(certificate.circuit.nand <= 8, `majority3 took ${certificate.circuit.nand} NAND`);
});

test("a 4-bit adder with carry compiles exactly on all 512 rows", () => {
  const table = combinationalTable({ nIn: 9, nOut: 5, fn: "(x&15)+((x>>4)&15)+((x>>8)&1)" });
  const { circuit, certificate } = compileTable(table, { steps: STEPS });
  assert.equal(checkExhaustive(circuit, table.ys).wrong, 0);
  assert.equal(certificate.verification.rowsChecked, 512);
  assert.ok(certificate.synthesis.nandAfterAnnealing <= certificate.synthesis.nandAfterSynthesis);
});

test("random tables of every small shape compile exactly", () => {
  const rng = createRng(7);
  for (let i = 0; i < 25; i++) {
    const nIn = 1 + Math.floor(rng() * 6);
    const nOut = 1 + Math.floor(rng() * 3);
    const ys = Uint32Array.from({ length: 2 ** nIn }, () => Math.floor(rng() * 2 ** nOut));
    const table = { nIn, nState: 0, nOut, ys };
    const { circuit } = compileTable(table, { steps: 2_000 });
    assert.equal(checkExhaustive(circuit, ys).wrong, 0, `shape ${nIn}/${nOut}`);
  }
});

test("the same table and seed give byte-identical netlists and certificates", () => {
  const table = gridTable({ fn: "x > y + 3 ? 1 : y > x + 3 ? 2 : x + y > 20 ? 3 : 0" }).table;
  const a = compileTable(table, { steps: STEPS });
  const b = compileTable(table, { steps: STEPS });
  assert.equal(a.circuit.netlistHex, b.circuit.netlistHex);
  assert.deepEqual(a.certificate, b.certificate);
  const c = compileTable(table, { steps: STEPS, seed: a.certificate.reproduce.seed });
  assert.equal(c.circuit.netlistHex, a.circuit.netlistHex, "passing the recorded seed reproduces the default run");
});

test("the table digest depends on shape and contents", () => {
  const ys = Uint32Array.from([0, 1, 1, 0]);
  const d = tableDigest({ nIn: 2, nState: 0, nOut: 1, ys });
  assert.notEqual(d, tableDigest({ nIn: 2, nState: 0, nOut: 2, ys }));
  assert.notEqual(d, tableDigest({ nIn: 2, nState: 0, nOut: 1, ys: Uint32Array.from([0, 1, 1, 1]) }));
});

test("a state machine compiles exactly on every (input, state) pair", () => {
  // 2-bit up counter with enable on input 0; output 1 when the count wraps
  const table = fsmTable({ nIn: 1, nState: 2, nOut: 1, fn: "[x && s === 3 ? 1 : 0, x ? (s + 1) % 4 : s]" });
  const { circuit, certificate } = compileTable(table, { steps: STEPS });
  assert.equal(circuit.nLatch, 2);
  assert.equal(checkExhaustive(circuit, table.ys).wrong, 0);
  assert.equal(certificate.verification.rowsChecked, 8);
  assert.deepEqual(reachableStates(table), [0, 1, 2, 3]);
});

test("tables reject incomplete, duplicated and out-of-range rows", () => {
  assert.throws(() => combinationalTable({ nIn: 2, nOut: 1, rows: [[0, 0], [1, 1], [2, 1]] }), /all 4/);
  assert.throws(() => combinationalTable({ nIn: 1, nOut: 1, rows: [[0, 0], [0, 1]] }), /twice/);
  assert.throws(() => combinationalTable({ nIn: 2, nOut: 1, fn: "x" }), /not an integer in 0..1/);
  assert.throws(() => gridTable({ map: [[0]] }), /16x16/);
  assert.throws(() => fsmTable({ nIn: 1, nState: 1, nOut: 1, fn: "[0, 2]" }), /next state/);
  assert.throws(() => compileTable({ nIn: 21, nState: 0, nOut: 1, ys: new Uint32Array(2) }), /1..20 bits/);
});

test("compile-table CLI writes a netlist whose bytes decode to a verified circuit", () => {
  const out = tempDir();
  const r = runScript("scripts/compile-table.mjs", ["--fn", "(x&1)^((x>>1)&1)", "--nIn", "2", "--nOut", "1", "--name", "xor2", "--steps", "5000", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /xor2: \d+ NAND, depth \d+, \d+ bytes; 4\/4 rows exact/);
  const { circuit } = readNetlist(join(out, "circuit.netlist.json"));
  const table = JSON.parse(readFileSync(join(out, "table.json"), "utf8"));
  assert.equal(checkExhaustive(circuit, Uint32Array.from(table.ys)).wrong, 0);
  const cert = JSON.parse(readFileSync(join(out, "circuit.certificate.json"), "utf8"));
  assert.equal(cert.name, "xor2");
  assert.equal(cert.verification.wrong, 0);
});

test("compile-grid CLI records choices that never occur", () => {
  const out = tempDir();
  const r = runScript("scripts/compile-grid.mjs", ["--fn", "x >= y ? 0 : 2", "--labels", "left,up,right,down", "--name", "grid-demo", "--steps", "5000", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const cert = JSON.parse(readFileSync(join(out, "circuit.certificate.json"), "utf8"));
  assert.deepEqual(cert.grid.neverChosen, ["up", "down"]);
  assert.equal(cert.grid.choices.left + cert.grid.choices.right, 256);
  assert.equal(cert.verification.rowsChecked, 256);
});

test("annealing for PoD cost trades gates for depth and is recorded so it reproduces", () => {
  const table = gridTable({ map: JSON.parse(readFileSync(join(ROOT, "examples", "grid-demo.map.json"), "utf8")) }).table;
  const gates = compileTable(table, { steps: STEPS });
  const cost = compileTable(table, { steps: STEPS, objective: "cost" });
  assert.equal("objective" in gates.certificate.reproduce, false, "default certificates stay as they were");
  assert.equal(cost.certificate.reproduce.objective, "cost");
  assert.ok(cost.certificate.circuit.podCost < gates.certificate.circuit.podCost, `cost objective ${cost.certificate.circuit.podCost}, gates objective ${gates.certificate.circuit.podCost}`);
  assert.equal(checkExhaustive(cost.circuit, table.ys).wrong, 0);
  const again = compileTable(table, { steps: STEPS, seed: cost.certificate.reproduce.seed, objective: "cost" });
  assert.equal(again.circuit.netlistHex, cost.circuit.netlistHex);
  assert.throws(() => compileTable(table, { objective: "speed" }), /objective must be gates or cost/);
});

test("compile CLIs take --objective and refuse anything else", () => {
  const out = tempDir();
  const args = ["--fn", "((x&1)+((x>>1)&1)+((x>>2)&1))>=2?1:0", "--nIn", "3", "--nOut", "1", "--name", "maj", "--steps", "3000", "--out", out];
  const r = runScript("scripts/compile-table.mjs", [...args, "--objective", "cost"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cost objective\)/);
  assert.equal(JSON.parse(readFileSync(join(out, "circuit.certificate.json"), "utf8")).reproduce.objective, "cost");
  const bad = runScript("scripts/compile-table.mjs", [...args, "--objective", "speed"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--objective must be gates or cost, got "speed"/);
});

test("CLI errors are one line, exit 1, and write nothing", () => {
  const out = tempDir();
  const r = runScript("scripts/compile-table.mjs", ["--fn", "x", "--nIn", "2", "--nOut", "1", "--name", "bad", "--out", join(out, "x")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: /);
  assert.equal(existsSync(join(out, "x")), false);
});
