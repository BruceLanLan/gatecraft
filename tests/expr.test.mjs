// The expression front end: the language, its semantics, the structural compiler, and how
// compileTable uses a structural start.
//
// The structural circuit is only a candidate - compileTable checks it and silently falls back
// to the BDD if it is wrong. That fallback protects users but would hide a broken builder, so
// the fuzz test below checks the structural circuit itself on every row, not the final compile.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileTable } from "../src/compile.mjs";
import { ExprError, parseExpression, parseProgram, programFromFn, programTable } from "../src/expr.mjs";
import { compileSpec } from "../src/job.mjs";
import { rebuild } from "../src/rebuild.mjs";
import { createRng } from "../src/rng.mjs";
import { buildStructural, NotStructural } from "../src/structural.mjs";
import { combinationalTable } from "../src/tables.mjs";
import { checkExhaustive } from "../src/verify.mjs";

const structuralIsExact = (program) => {
  const { gates, outputs } = buildStructural(program);
  const circuit = rebuild({ nIn: program.nIn, nLatch: 0, gates, outputs, nOut: program.nOut });
  return { check: checkExhaustive(circuit, programTable(program).ys), circuit };
};

test("operator precedence follows JavaScript", () => {
  // & binds looser than ==, << looser than +, ?: is right-associative
  assert.equal(parseExpression("a & 1 == 1").op, "&");
  assert.equal(parseExpression("a << 1 + 2").args[1].op, "+");
  const t = parseExpression("a ? b : c ? d : e");
  assert.equal(t.op, "?:");
  assert.equal(t.args[2].op, "?:");
});

test("on non-negative 31-bit arithmetic the semantics agree with JavaScript", () => {
  const rng = createRng(3);
  const exprs = ["a + b * 3", "(a ^ b) & 0x3f | a << 2", "a > b ? a - b : b - a", "a % 8 + (b >> 2)", "(a & ~b) & 255", "a == b || a < 4 && b >= 9", "a[5:2] + b[0]"];
  const js = { "a[5:2] + b[0]": (a, b) => ((a >> 2) & 15) + (b & 1) };
  for (const e of exprs) {
    const program = parseProgram({ inputs: { a: 8, b: 8 }, outputs: { y: { width: 20, expr: e } } });
    const table = programTable(program);
    const f = js[e] ?? new Function("a", "b", `return Number(${e})`);
    for (let n = 0; n < 200; n++) {
      const a = Math.floor(rng() * 256), b = Math.floor(rng() * 256);
      assert.equal(table.ys[a | (b << 8)], (f(a, b) >>> 0) & 0xfffff, `${e} at a=${a} b=${b}`);
    }
  }
});

test("outputs are taken modulo 2^width, so negative values wrap like hardware", () => {
  const t = programTable(parseProgram({ inputs: { a: 4 }, outputs: { d: { width: 4, expr: "a - 5" }, n: { width: 4, expr: "~a" } } }));
  assert.equal(t.ys[3] & 15, (3 - 5) & 15);      // 14
  assert.equal((t.ys[3] >>> 4) & 15, ~3 & 15);   // 12
});

test("errors say what is wrong and where, so the writer can fix it", () => {
  const msg = (spec) => { try { parseProgram(spec); } catch (e) { assert.ok(e instanceof ExprError, e.message); return e.message; } assert.fail("no error"); };
  assert.match(msg({ inputs: { a: 8 }, outputs: { y: { width: 8, expr: "a + c" } } }), /unknown name "c".*position 4/);
  assert.match(msg({ inputs: { a: 8 }, outputs: { y: { width: 8, expr: "a +* 3" } } }), /unexpected "\*" at position 3/);
  assert.match(msg({ inputs: { a: 8 }, outputs: { y: { width: 8, expr: "a / (a - 1)" } } }), /divisor that is always at least 1/);
  assert.match(msg({ inputs: { a: 8 }, outputs: { y: { width: 8, expr: "(a - 9) >>> 1" } } }), />>>" needs a value that cannot be negative/);
  assert.match(msg({ inputs: { a: 21 }, outputs: { y: { width: 8, expr: "a" } } }), /1\.\.20/);
  assert.match(msg({ inputs: { a: 8 }, outputs: { a: { width: 8, expr: "a" } } }), /used twice/);
  assert.match(msg({ inputs: { a: 8 }, outputs: { y: { expr: "a" } } }), /"width"/);
  assert.match(msg({ inputs: { a: 8 }, outputs: { y: { width: 8, expr: "a[3:5]" } } }), /high index below its low index/);
});

// ---- fuzz: random programs, the structural circuit checked on every row

function randomExpression(rng, names, depth) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  if (depth === 0 || rng() < 0.25) {
    return rng() < 0.7 ? pick(names) : String(Math.floor(rng() * 20));
  }
  const sub = () => randomExpression(rng, names, depth - 1);
  const kind = Math.floor(rng() * 10);
  if (kind === 0) return `${pick(["~", "!", "-"])}(${sub()})`;
  if (kind === 1) return `(${sub()}) ? (${sub()}) : (${sub()})`;
  if (kind === 2) return `(${sub()}) ${pick(["<<", ">>"])} ${Math.floor(rng() * 4)}`;
  if (kind === 3) return `(${pick(names)}) ${pick(["<<", ">>"])} (${pick(names)} & 3)`;
  if (kind === 4) { const hi = Math.floor(rng() * 5); return `(${sub()})[${hi}:${Math.floor(rng() * (hi + 1))}]`; }
  if (kind === 5) return `(${pick(names)}) ${pick(["/", "%"])} ${pick(["1", "2", "4", "8"])}`;
  return `(${sub()}) ${pick(["+", "-", "*", "&", "|", "^", "==", "!=", "<", "<=", ">", ">=", "&&", "||"])} (${sub()})`;
}

test("fuzz: every structurally compiled random program is exact on every row", () => {
  const rng = createRng(20260917);
  let checked = 0;
  for (let n = 0; n < 600 && checked < 300; n++) {
    const widths = [1 + Math.floor(rng() * 4), 1 + Math.floor(rng() * 4), 1 + Math.floor(rng() * 3)];
    const inputs = { p: widths[0], q: widths[1], r: widths[2] };
    const outputs = {};
    const nOuts = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < nOuts; k++) outputs[`y${k}`] = { width: 1 + Math.floor(rng() * 8), expr: randomExpression(rng, ["p", "q", "r"], 3) };
    let program;
    try {
      program = parseProgram({ inputs, outputs });
    } catch (e) {
      if (e instanceof ExprError) continue; // e.g. a random division whose dividend can be negative
      throw e;
    }
    const { check } = structuralIsExact(program);
    assert.equal(check.wrong, 0, `inexact on ${check.wrong} rows: ${JSON.stringify(outputs)} over ${JSON.stringify(inputs)}`);
    checked++;
  }
  assert.ok(checked >= 300, `only ${checked} random programs were valid`);
});

test("structural compilation of arithmetic is far smaller than the table route", () => {
  const add = parseProgram({ inputs: { a: 8, b: 8 }, outputs: { s: { width: 9, expr: "a + b" } } });
  const mul = parseProgram({ inputs: { a: 6, b: 6 }, outputs: { p: { width: 12, expr: "a * b" } } });
  assert.equal(structuralIsExact(add).circuit.nNand, 68);   // eight adders: a half and seven nine-NAND full adders
  assert.ok(structuralIsExact(mul).circuit.nNand < 400);    // the table route gives about 2,700
});

test("general division is not built structurally, and the table route still compiles it", () => {
  const program = parseProgram({ inputs: { a: 6, b: 3 }, outputs: { q: { width: 6, expr: "a / (b + 1)" } } });
  assert.throws(() => buildStructural(program), NotStructural);
  const { certificate } = compileSpec("expr", { inputs: { a: 6, b: 3 }, outputs: { q: { width: 6, expr: "a / (b + 1)" } } }, { steps: 2000 });
  assert.equal(certificate.verification.wrong, 0);
  assert.equal(certificate.synthesis.frontEnd, undefined); // no candidate was offered, so no choice was recorded
});

test("an expr compile starts from the smaller exact start and says where every name lives", () => {
  const { certificate, circuit } = compileSpec("expr", {
    inputs: { a: 5, b: 5, sel: 1 },
    outputs: { sum: { width: 6, expr: "a + b" }, pick: { width: 5, expr: "sel ? a : b" } },
  }, { steps: 5000 });
  assert.equal(certificate.verification.wrong, 0);
  assert.equal(certificate.synthesis.frontEnd, "expression");
  const starts = Object.fromEntries(certificate.synthesis.startsConsidered.map((s) => [s.frontEnd, s]));
  assert.ok(starts.expression.exact && starts.expression.nand <= starts.bdd.nand);
  assert.equal(certificate.synthesis.nandAfterSynthesis, starts.expression.nand);
  assert.ok(circuit.nNand <= starts.expression.nand);
  assert.deepEqual(certificate.expression.inputs.map((i) => i.at), ["bits 0-4", "bits 5-9", "bit 10"]);
  assert.deepEqual(certificate.expression.outputs.map((o) => o.at), ["bits 0-5", "bits 6-10"]);
});

test("a table given as fn gets a structural start when the language can read it", () => {
  const adder = compileSpec("table", { nIn: 8, nOut: 5, fn: "(x & 15) + (x >>> 4)" }, { steps: 2000 });
  assert.equal(adder.certificate.synthesis.frontEnd, "expression");
  assert.equal(adder.certificate.verification.wrong, 0);
  // an immediately invoked function is JavaScript the expression language does not read
  assert.equal(programFromFn("(()=>{let c=0;for(let v=x;v;v>>>=1)c+=v&1;return c})()", 8, 4), null);
  const count = compileSpec("table", { nIn: 8, nOut: 4, fn: "(()=>{let c=0;for(let v=x;v;v>>>=1)c+=v&1;return c})()" }, { steps: 2000 });
  assert.equal(count.certificate.synthesis.frontEnd, undefined);
  assert.equal(count.certificate.verification.wrong, 0);
});

test("an inexact candidate is recorded, dropped, and never annealed", () => {
  const table = combinationalTable({ nIn: 4, nOut: 1, fn: "x > 9 ? 1 : 0" });
  // a deliberately wrong start: the output is just input bit 0
  const wrong = { frontEnd: "expression", gates: [], outputs: [2] };
  const { certificate } = compileTable(table, { steps: 2000, candidates: [wrong] });
  const starts = Object.fromEntries(certificate.synthesis.startsConsidered.map((s) => [s.frontEnd, s]));
  assert.equal(starts.expression.exact, false);
  assert.equal(certificate.synthesis.frontEnd, "bdd");
  assert.equal(certificate.verification.wrong, 0);
});

// ---- examples: a program's own tests, checked before anything is compiled

import { describeFailure, exampleFailures, runProgram } from "../src/expr.mjs";
import { explainProgram, sampleRows } from "../src/explain.mjs";

test("examples are validated, checked, and a contradicted program is not compiled", () => {
  const base = { inputs: { a: 4, b: 4 }, outputs: { larger: { width: 4, expr: "a > b ? a : b" }, same: { width: 1, expr: "a == b" } } };
  const bad = (examples) => { try { parseProgram({ ...base, examples }); } catch (e) { return e.message; } return "accepted"; };
  assert.match(bad({}), /must be a list/);
  assert.match(bad([{ given: { a: 1 }, expect: { larger: 1 } }]), /example 1: gives no value for input "b"/);
  assert.match(bad([{ given: { a: 1, b: 2, c: 3 }, expect: { larger: 2 } }]), /"c" is not an input/);
  assert.match(bad([{ given: { a: 16, b: 2 }, expect: { larger: 2 } }]), /a = 16 must be a whole number 0\.\.15/);
  assert.match(bad([{ given: { a: 1, b: 2 }, expect: {} }]), /expects no output/);

  const program = parseProgram({ ...base, examples: [{ given: { a: 3, b: 5 }, expect: { larger: 5, same: 0 } }, { given: { a: 9, b: 9 }, expect: { larger: 9, same: 0 } }] });
  assert.deepEqual(runProgram(program, { a: 9, b: 9 }), { larger: 9, same: 1 });
  const failures = exampleFailures(program);
  assert.equal(failures.length, 1);
  assert.equal(describeFailure(failures[0]), "example 2: given a=9 b=9, expected same=0 but the program gives same=1");
  assert.throws(() => compileSpec("expr", { ...base, examples: program.examples }, { steps: 10 }), /1 of 2 examples do not hold, so nothing was compiled; example 2/);
  const ok = compileSpec("expr", { ...base, examples: [program.examples[0]] }, { steps: 10 });
  assert.equal(ok.certificate.expression.examplesHold, 1);
  assert.equal(compileSpec("expr", base, { steps: 10 }).certificate.expression.examplesHold, undefined);
});

test("a program reads back in words, grouped so the words cannot be misread", () => {
  const program = parseProgram({
    inputs: { a: 3, b: 3 },
    let: { big: "a > 5" },
    outputs: { y: { width: 1, expr: "big || a > 1 && b < 2" }, d: { width: 4, expr: "a - (b - 1) * 2" }, t: { width: 2, expr: "a[2:1] + b[0]" } },
  });
  const en = explainProgram(program, "en");
  assert.deepEqual(en.lines, [
    "a: an input of 3 bits, 0 to 7",
    "b: an input of 3 bits, 0 to 7",
    "big means: a is greater than 5",
    "y (1 bit) = big or (a is greater than 1 and b is less than 2)",
    "d (4 bits) = a minus ((b minus 1) times 2)",
    "t (2 bits) = bits 2 to 1 of a plus bit 0 of b",
  ]);
  // exact over every row: d really goes negative, t really reaches 4
  assert.deepEqual(en.warnings, [
    "d reaches -12 to 9 before it is cut to 4 bits; negative values wrap around, and only the lowest 4 bits are kept.",
    "t reaches 0 to 4 before it is cut to 2 bits; only the lowest 2 bits are kept.",
  ]);
  const zh = explainProgram(program, "zh");
  assert.equal(zh.lines[3], "y（1 位）= big 或者（a 大于 1 并且 b 小于 2）");
  // an interval that is wider than the truth does not raise a false alarm
  const thermostat = parseProgram(JSON.parse(readFileSync(new URL("../examples/thermostat.expr.json", import.meta.url), "utf8")));
  assert.deepEqual(explainProgram(thermostat, "en").warnings, []);
  assert.deepEqual(sampleRows(parseProgram({ inputs: { a: 2 }, outputs: { y: { width: 2, expr: "a" } } })).map((r) => r.got.y), [0, 3, 2]);
});

// ---- state: memory in the expression language

test("fuzz: structurally compiled programs with state are exact on every (input, state) row", () => {
  const rng = createRng(917);
  let checked = 0;
  for (let n = 0; n < 400 && checked < 120; n++) {
    const inputs = { p: 1 + Math.floor(rng() * 3), q: 1 + Math.floor(rng() * 2) };
    const state = { s: { width: 1 + Math.floor(rng() * 3), next: randomExpression(rng, ["p", "q", "s"], 3) } };
    if (rng() < 0.4) state.t = { width: 1 + Math.floor(rng() * 2), next: randomExpression(rng, ["p", "s", "t"], 2) };
    const outputs = { y: { width: 1 + Math.floor(rng() * 6), expr: randomExpression(rng, Object.keys({ ...inputs, ...state }), 3) } };
    let program;
    try {
      program = parseProgram({ inputs, state, outputs });
    } catch (e) {
      if (e instanceof ExprError) continue;
      throw e;
    }
    const { gates, outputs: outs } = buildStructural(program);
    const circuit = rebuild({ nIn: program.nIn, nLatch: program.nState, gates, outputs: outs, nOut: program.nOut });
    const check = checkExhaustive(circuit, programTable(program).ys);
    assert.equal(check.wrong, 0, `inexact: ${JSON.stringify({ inputs, state, outputs })}`);
    checked++;
  }
  assert.ok(checked >= 120, `only ${checked} valid`);
});

test("a counter with state compiles to latches, and its examples cover the next state", () => {
  const spec = {
    inputs: { press: 1 },
    state: { count: { width: 4, next: "press ? (count == 9 ? 0 : count + 1) : count" } },
    outputs: { nine: { width: 1, expr: "count == 9" } },
    examples: [{ given: { press: 1 }, then: { count: 1 } }, { given: { press: 1, count: 9 }, expect: { nine: 1 }, then: { count: 0 } }],
  };
  const program = parseProgram(spec);
  assert.deepEqual(program.examples[0].given, { press: 1, count: 0 }); // state left out = power-on
  const { certificate, circuit } = compileSpec("expr", spec, { steps: 3000 });
  assert.equal(certificate.verification.wrong, 0);
  assert.equal(circuit.nLatch, 4);
  assert.deepEqual(certificate.stateMachine.reachableFromStart, 10);
  assert.deepEqual(certificate.expression.state, [{ name: "count", width: 4, at: "bits 0-3" }]);
  assert.equal(certificate.expression.examplesHold, 2);

  const wrong = { ...spec, examples: [{ given: { press: 1, count: 3 }, then: { count: 5 } }] };
  assert.throws(() => compileSpec("expr", wrong, { steps: 10 }), /example 1: given press=1 count=3, expected next count=5 but the program gives next count=4/);
  const bad = (s) => { try { parseProgram(s); } catch (e) { return e.message; } return "accepted"; };
  assert.match(bad({ ...spec, state: { count: { width: 4 } } }), /needs a "next" expression/);
  assert.match(bad({ ...spec, examples: [{ given: { press: 1 }, then: { nine: 1 } }] }), /"nine" is not a state/);
  assert.match(bad({ ...spec, examples: [{ given: { press: 1 } }] }), /expects no output and no next state/);
  assert.match(bad({ inputs: { a: 16 }, state: { s: { width: 5, next: "s" } }, outputs: { y: { width: 1, expr: "a" } } }), /inputs and state add up to 21 bits/);
  assert.match(explainProgram(program, "en").lines.at(-1), /^after each tick, count becomes if press then/);
});

test("bitwise operators on a negative and a non-negative value get a wide enough range", () => {
  // -1 ^ 1 = -2: the non-negative side needs its sign bit too. Found by the state fuzz test.
  const program = parseProgram({ inputs: { q: 1, s: 1 }, outputs: { n: { width: 3, expr: "(-s) ^ q" }, m: { width: 3, expr: "(-s) | q" }, k: { width: 3, expr: "(-s) & (q + 2)" } } });
  assert.equal(structuralIsExact(program).check.wrong, 0);
  const n = program.outputs[0].tree.range;
  assert.ok(n[0] <= -2n && n[1] >= 1n, `range ${n}`);
});
