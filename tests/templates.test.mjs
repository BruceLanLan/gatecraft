// Templates: the path for someone who never writes a sentence. Every template, at every knob
// setting, must compile to a circuit that is proven on every row and agrees with its own
// examples — otherwise it is not a starting point, it is a trap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleFailures, parseProgram, runStep } from "../src/expr.mjs";
import { compileSpec } from "../src/job.mjs";
import { TEMPLATES, fromTemplate, templateById, templateDefaults, templateParams } from "../src/templates.mjs";

const settings = (template) => {
  if (!template.params.length) return [{}];
  // every knob at its lowest, its default and its highest, one knob at a time
  const base = templateDefaults(template);
  const out = [base];
  for (const p of template.params) for (const value of [p.min, p.max]) out.push({ ...base, [p.name]: value });
  return out;
};

test("every template, at its edges, builds a program whose own examples hold", () => {
  let checked = 0;
  for (const template of TEMPLATES) {
    for (const knobs of settings(template)) {
      const built = fromTemplate(template.id, knobs, "zh");
      const program = parseProgram(built.spec);
      assert.ok(program.examples.length >= 3, `${template.id} ${JSON.stringify(knobs)}: at least three examples`);
      assert.deepEqual(exampleFailures(program).map((f) => f.index), [], `${template.id} ${JSON.stringify(knobs)}`);
      assert.ok(program.nIn + program.nState <= 20, `${template.id}: ${program.nIn + program.nState} bits in`);
      assert.ok(program.nOut + program.nState <= 32, `${template.id}: ${program.nOut + program.nState} bits out`);
      assert.ok(built.sentence.length > 8, `${template.id}: says what it is`);
      checked += 1;
    }
  }
  assert.ok(checked >= 16, `${checked} settings checked`);
});

test("each template's default setting compiles and is proven, and the app carries its sentence", () => {
  for (const template of TEMPLATES) {
    const built = fromTemplate(template.id, {}, "en");
    const result = compileSpec("expr", built.spec, { steps: 2000 });
    assert.equal(result.certificate.verification.wrong, 0, template.id);
    assert.ok(result.certificate.circuit.nand > 0, template.id);
    assert.equal(result.certificate.expression.examplesHold, built.spec.examples.length, template.id);
  }
});

test("knobs are checked, and an unknown template is refused", () => {
  const counter = templateById("counter");
  assert.deepEqual(templateDefaults(counter), { top: 9 });
  assert.deepEqual(templateParams(counter, { top: 15 }), { top: 15 });
  assert.throws(() => templateParams(counter, { top: 99 }), /top must be 3\.\.15/);
  assert.throws(() => templateParams(counter, { top: 2.5 }), /whole number/);
  assert.throws(() => templateParams(templateById("vote"), { people: 4 }), /people must be 3, 5, 7/);
  assert.throws(() => fromTemplate("nope"), /unknown template "nope"/);
  assert.equal(templateById("nope"), null);

  // the sentence follows the knobs, in both languages
  assert.match(fromTemplate("vote", { people: 7 }, "zh").sentence, /7 个人投票/);
  assert.match(fromTemplate("vote", { people: 7 }, "en").sentence, /^7 people vote/);
  assert.match(fromTemplate("counter", { top: 15 }, "zh").sentence, /到 15 之后回到 0/);
});

test("the digit display really draws the digits, and the traffic light really cycles", () => {
  const digit = compileSpec("expr", fromTemplate("digit").spec, { steps: 2000 });
  const strokes = (n) => {
    const row = digit.table.ys[n];
    return Array.from({ length: 7 }, (_, k) => (row >> k) & 1);
  };
  assert.deepEqual(strokes(0), [1, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual(strokes(1), [0, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(strokes(7), [1, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(strokes(9), [1, 1, 1, 0, 0, 1, 1]);
  for (const dark of [10, 11, 15]) assert.deepEqual(strokes(dark), [0, 0, 0, 0, 0, 0, 0], `${dark} stays dark`);

  const traffic = fromTemplate("traffic").spec;
  const program = parseProgram(traffic);
  let phase = 0;
  const seen = [];
  for (let tick = 0; tick < 4; tick++) {
    const row = compileSpec("expr", traffic, { steps: 500 }).table.ys[1 + phase * 2];
    seen.push([row & 1, (row >> 1) & 1, (row >> 2) & 1]);
    phase = (row >> 3) & 3;
  }
  assert.deepEqual(seen, [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]], "red, green, yellow, red");
  assert.equal(program.nState, 2);
});

// Running a program tick by tick, the way the exported app does: give the inputs, read the
// outputs, keep the next state for the tick after. The four templates below exist because a
// local model kept failing at exactly these shapes, so their behaviour is worth pinning down.
const run = (id, knobs, steps) => {
  const program = parseProgram(fromTemplate(id, knobs).spec);
  let state = Object.fromEntries((program.states ?? []).map((s) => [s.name, 0]));
  const seen = [];
  for (const inputs of steps) {
    const tick = runStep(program, { ...state, ...inputs });
    seen.push(tick.outputs);
    state = tick.next;
  }
  return seen;
};

test("the thermostat holds its mind between the two marks", () => {
  const cold = { temp: 18 }, warm = { temp: 22 }, hot = { temp: 26 };
  // 20 on, 24 off: warm on its own decides nothing - what happened before decides.
  const seen = run("thermostat", { low: 20, span: 4 }, [warm, cold, warm, warm, hot, warm]);
  assert.deepEqual(seen.map((o) => o.heat), [0, 0, 1, 1, 1, 0], "off, still off, on, stays on, on, off");
  assert.deepEqual(seen.map((o) => o.cold), [0, 1, 0, 0, 0, 0]);
});

test("the lift moves one floor a tick and stops when it arrives", () => {
  const none = { call1: 0, call2: 0, call3: 0 };
  const seen = run("elevator", { floors: 3 }, [{ ...none, call3: 1 }, none, none, none, { ...none, call1: 1 }, none, none]);
  assert.deepEqual(seen.map((o) => o.floor), [0, 0, 1, 2, 2, 2, 1], "waits a tick for the call, climbs, stops, comes back");
  assert.deepEqual(seen.map((o) => o.moving), [0, 1, 1, 0, 0, 1, 1]);
  assert.deepEqual(seen.map((o) => o.up), [0, 1, 1, 0, 0, 0, 0]);
});

test("the lock opens only on the code and closes only on reset", () => {
  const at = (dial, enter, reset = 0) => ({ dial, enter, reset });
  const seen = run("lock", { bits: 6, code: 42 }, [at(41, 1), at(42, 0), at(42, 1), at(0, 0), at(0, 0, 1), at(0, 0)]);
  assert.deepEqual(seen.map((o) => o.unlocked), [0, 0, 0, 1, 1, 0], "wrong code, no press, right code, open, reset, shut");
  assert.deepEqual(seen.map((o) => o.right), [0, 0, 1, 0, 0, 0]);
});

test("the scoreboard stops at both ends, and the coin machine gives change", () => {
  const press = (given) => ({ a_up: 0, a_down: 0, b_up: 0, b_down: 0, ...given });
  const board = run("scoreboard", { top: 3 }, [press({ a_down: 1 }), press({ a_up: 1 }), press({ a_up: 1 }), press({ a_up: 1 }), press({ a_up: 1 }), press({ b_up: 1 })]);
  assert.deepEqual(board.map((o) => o.home), [0, 0, 1, 2, 3, 3], "minus at zero does nothing, and it stops at the top");
  assert.deepEqual(board.map((o) => o.ahead), [0, 0, 1, 1, 1, 1]);

  const small = { small: 1, big: 0 }, big = { small: 0, big: 1 }, none = { small: 0, big: 0 };
  const coins = run("vending", { price: 3 }, [small, none, small, small, small, small, big]);
  assert.deepEqual(coins.map((o) => o.serve), [0, 0, 0, 1, 0, 0, 1], "the third small coin buys it");
  assert.deepEqual(coins.map((o) => o.paid), [0, 1, 1, 2, 0, 1, 2], "and the machine starts over");
  // A big coin on top of two smalls is the whole reason it exists: 4 paid for a 3 drink.
  assert.deepEqual(coins.map((o) => o.change), [0, 0, 0, 0, 0, 0, 1], "the change comes back");
});

test("the allowance stops at the day's limit, and a reset starts the day again", () => {
  const press = { press: 1, reset: 0 }, idle = { press: 0, reset: 0 }, clear = { press: 0, reset: 1 };
  const seen = run("quota", { perDay: 3 }, [press, press, press, press, press, clear, press, idle]);
  assert.deepEqual(seen.map((o) => o.served), [0, 1, 2, 3, 3, 3, 0, 1], "three a day, then nothing until the reset");
  assert.deepEqual(seen.map((o) => o.gives), [1, 1, 1, 0, 0, 0, 1, 0], "the fourth press hands out nothing");
  assert.deepEqual(seen.map((o) => o.full), [0, 0, 0, 1, 1, 1, 0, 0]);
});
