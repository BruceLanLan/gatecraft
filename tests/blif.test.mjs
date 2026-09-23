// The BLIF export: read it back with an independent reader and compare with the circuit on
// every row. A fab's tools (and tapeout.net's canvas) read this file, so it has to mean
// exactly what the certificate proved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { BLIF_ONE, BLIF_ZERO, blifNames, toBlif } from "../src/blif.mjs";
import { compileSpec } from "../src/job.mjs";
import { decodeCircuit, hexToBytes, simulate } from "../src/netlist.mjs";

// A small BLIF reader: .names rows, .latch lines, .inputs/.outputs. It knows nothing about
// gatecraft's own structures, which is the point.
function readBlif(text) {
  const inputs = [];
  const outputs = [];
  const gates = [];
  const latches = [];
  const lines = text.split("\n").map((line) => line.replace(/#.*/, ""));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(".inputs")) inputs.push(...line.split(/\s+/).slice(1));
    else if (line.startsWith(".outputs")) outputs.push(...line.split(/\s+/).slice(1));
    else if (line.startsWith(".latch")) {
      const [, d, q, , , init] = line.split(/\s+/);
      latches.push({ d, q, init: Number(init ?? 0) });
    } else if (line.startsWith(".names")) {
      const pins = line.split(/\s+/).slice(1);
      const out = pins.pop();
      const rows = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith(".")) {
        const row = lines[++i];
        if (row.trim() === "") continue;
        const parts = row.trim().split(/\s+/);
        rows.push(parts.length === 1 ? { pattern: "", value: Number(parts[0]) } : { pattern: parts[0], value: Number(parts[1]) });
      }
      gates.push({ inputs: pins, out, rows });
    }
  }
  return { inputs, outputs, gates, latches };
}

// One evaluation of a read-back BLIF, given input and latch values by name.
function runBlif(blif, inputValues, latchValues) {
  const value = new Map([[BLIF_ZERO, 0], [BLIF_ONE, 1]]);
  blif.inputs.forEach((pin, i) => value.set(pin, inputValues[i]));
  blif.latches.forEach((latch, i) => value.set(latch.q, latchValues[i]));
  let left = blif.gates.filter((gate) => !value.has(gate.out) || gate.inputs.length);
  for (let pass = 0; pass < left.length + 2 && left.length; pass++) {
    left = left.filter((gate) => {
      if (!gate.inputs.every((pin) => value.has(pin))) return true;
      const bits = gate.inputs.map((pin) => value.get(pin));
      const hit = gate.rows.some((row) => row.value === 1 && [...row.pattern].every((want, k) => want === "-" || Number(want) === bits[k]));
      const constant = gate.rows.length === 1 && gate.rows[0].pattern === "";
      value.set(gate.out, constant ? gate.rows[0].value : hit ? 1 : 0);
      return false;
    });
  }
  assert.equal(left.length, 0, "every gate resolved");
  return {
    outputs: blif.outputs.map((pin) => value.get(pin)),
    next: blif.latches.map((latch) => value.get(latch.d)),
  };
}

const SPECS = {
  vote: { inputs: { a: 1, b: 1, c: 1 }, outputs: { pass: { width: 1, expr: "a + b + c >= 2" } } },
  counter: JSON.parse(readFileSync(new URL("../examples/counter.expr.json", import.meta.url), "utf8")),
  max: JSON.parse(readFileSync(new URL("../examples/max.expr.json", import.meta.url), "utf8")),
  toggle: JSON.parse(readFileSync(new URL("../examples/toggle.expr.json", import.meta.url), "utf8")),
  constant: { inputs: { a: 2 }, outputs: { zero: { width: 1, expr: "0" }, one: { width: 1, expr: "1" }, same: { width: 2, expr: "a" } } },
};

test("a BLIF export means the same thing as the circuit, on every row", () => {
  for (const [name, spec] of Object.entries(SPECS)) {
    const result = compileSpec("expr", spec, { steps: 3000 });
    const circuit = decodeCircuit(hexToBytes(result.circuit.netlistHex), result.circuit.nIn, result.circuit.nOut);
    const text = toBlif(circuit, { name, names: blifNames(result.certificate.expression) });
    const blif = readBlif(text);

    assert.equal(blif.inputs.length, circuit.nIn, `${name}: input pins`);
    assert.equal(blif.outputs.length, circuit.nOut, `${name}: output pins`);
    assert.equal(blif.latches.length, circuit.nLatch, `${name}: latches`);
    assert.ok(blif.latches.every((latch) => latch.init === 0), `${name}: latches start at 0`);

    for (let row = 0; row < 2 ** (circuit.nIn + circuit.nLatch); row++) {
      const inputs = Array.from({ length: circuit.nIn }, (_, i) => (row >> i) & 1);
      const state = Array.from({ length: circuit.nLatch }, (_, i) => (row >> (circuit.nIn + i)) & 1);
      const want = simulate(circuit, inputs, Uint8Array.from(state));
      const got = runBlif(blif, inputs, state);
      assert.deepEqual(got.outputs, [...want.outputs], `${name}: outputs at row ${row}`);
      assert.deepEqual(got.next, [...want.newState], `${name}: next state at row ${row}`);
    }
  }
});

test("the export names its pins after the program and says what it is", () => {
  const result = compileSpec("expr", SPECS.counter, { steps: 2000 });
  const circuit = decodeCircuit(hexToBytes(result.circuit.netlistHex), result.circuit.nIn, result.circuit.nOut);
  const text = toBlif(circuit, { name: "counter", names: blifNames(result.certificate.expression) });
  assert.match(text, /^# counter: \d+ NAND \+ 4 LATCH, written by gatecraft$/m);
  assert.match(text, /^\.model counter$/m);
  assert.match(text, /^\.inputs x0_press$/m);
  assert.match(text, /^\.outputs y0_digit0 y1_digit1 y2_digit2 y3_digit3 y4_nine$/m);
  assert.match(text, /^\.latch \S+ s0_count0 re clk 0$/m);
  assert.match(text, /^\.end$/m);
  // Every .names has one or two inputs, which is all some importers accept (a zero-input
  // constant table is legal BLIF but tapeout.firsto.ai's importer refuses it).
  const names = text.split("\n").filter((line) => line.startsWith(".names"));
  assert.ok(names.length >= circuit.nNand);
  for (const line of names) {
    const pins = line.split(/\s+/).length - 1;
    assert.ok(pins === 2 || pins === 3, `"${line}" has ${pins - 1} input(s)`);
  }
  // one NAND table per gate, plus the one that builds the constant 1
  assert.equal(text.split("\n").filter((line) => line === "0- 1").length, circuit.nNand + 1);
  assert.match(text, /^\.names x0_press n_not_x0_press$/m);

  // without program names the pins stay plain
  const plain = toBlif(circuit, { name: "counter" });
  assert.match(plain, /^\.inputs x0$/m);
});
