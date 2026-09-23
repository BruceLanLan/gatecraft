// A second, independent proof: Yosys reads the table and the circuit and proves them equal.
//
// The whole point is that nothing from this repository takes part in the proof except the
// two files, so these tests run the real yosys when it is installed and are skipped when it
// is not. The mutant case is the one that matters: a proof that has never been seen to fail
// is decoration.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { booleanIrFiles, equivalenceScript, specBlif } from "../src/boolean-ir.mjs";
import { blifNames } from "../src/blif.mjs";
import { compileSpec } from "../src/job.mjs";
import { compileTable } from "../src/compile.mjs";
import { OPCODE } from "../src/netlist.mjs";
import { fromTemplate } from "../src/templates.mjs";
import { proveWithYosys, yosysAvailable } from "../src/yosys.mjs";

const yosys = yosysAvailable();
const withYosys = { skip: yosys ? false : "yosys is not installed" };

const compiled = (id, knobs = {}) => {
  const out = compileSpec("expr", fromTemplate(id, knobs).spec, { steps: 500 });
  return { out, names: blifNames(out.certificate.expression) };
};

test("the table is written as BLIF logic with the same pins as the circuit", () => {
  const { out, names } = compiled("vote", { people: 3 });
  const text = specBlif(out.table, { name: "vote_spec", names });
  assert.match(text, /^\.model vote_spec$/m);
  assert.match(text, /^\.inputs x0_v1 x1_v2 x2_v3$/m);
  assert.match(text, /^\.outputs y0_pass$/m);
  // Majority of three: exactly the four rows with two or more ones are on.
  const on = text.split("\n").filter((l) => /^[01]{3} 1$/.test(l));
  assert.deepEqual(on.sort(), ["011 1", "101 1", "110 1", "111 1"]);
  assert.match(equivalenceScript(), /miter -equiv/);
});

test("a table with state, or too wide to write out, is refused with the reason", () => {
  const { out } = compiled("counter", {});
  assert.throws(() => specBlif(out.table), /state/);
  assert.throws(() => specBlif({ nIn: 17, nOut: 1, ys: new Uint32Array(2 ** 17) }), /17 input bits/);
});

test("Yosys proves every exported combinational template equal to its table", withYosys, () => {
  for (const [id, knobs] of [["vote", { people: 5 }], ["compare", { bits: 4 }], ["digit", {}], ["threshold", {}]]) {
    const { out, names } = compiled(id, knobs);
    const result = proveWithYosys(booleanIrFiles(id, out, { names }));
    assert.ok(result.proven, `${id}: ${result.log.split("\n").slice(-6).join(" | ")}`);
  }
});

test("Yosys refuses a circuit with one gate rewired: the proof can fail, so it means something", withYosys, () => {
  const { out, names } = compiled("compare", { bits: 3 });
  const bent = { ...out.circuit, elements: out.circuit.elements.map((e) => ({ ...e })) };
  const gate = bent.elements.findIndex((e) => e.op === OPCODE.NAND);
  bent.elements[gate].a = bent.elements[gate].a === 0 ? 1 : 0;
  const result = proveWithYosys(booleanIrFiles("compare3", { circuit: bent, table: out.table }, { names }));
  assert.equal(result.proven, false);
  assert.match(result.log, /model found: FAIL/);
});

test("the decision table filled by the decision model is proven equal to its circuit by Yosys", withYosys, () => {
  // The real fill from tools/jev-table.mjs, frozen the same way the tool froze it.
  const evidence = JSON.parse(readFileSync(new URL("./fixtures/jev-table-mario-ruled.json", import.meta.url), "utf8"));
  const ys = new Uint32Array(512);
  for (const r of evidence.rows) ys[r.row] = r.choice === "jump" ? 1 : 0;
  const table = { nIn: 9, nState: 0, nOut: 1, ys };
  const { circuit } = compileTable(table, { steps: 500 });
  const result = proveWithYosys(booleanIrFiles("mario_jump", { circuit, table }));
  assert.ok(result.proven, result.log.split("\n").slice(-6).join(" | "));
});
