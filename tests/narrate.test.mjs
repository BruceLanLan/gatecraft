// Watching it move is the only check that catches a circuit which is proven and still wrong.
// Four templates shipped that way, so these tests use those exact shapes: if the narration
// had existed, each bug would have been one sentence on the screen.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProgram } from "../src/expr.mjs";
import { fromTemplate } from "../src/templates.mjs";
import { everMoves, narrate, play } from "../src/narrate.mjs";

const program = (id, knobs) => parseProgram(fromTemplate(id, knobs).spec);

test("pressing the button tells the story of what happens, one line per press", () => {
  const lines = narrate(program("counter", { top: 9 }), { ticks: 3 });
  assert.deepEqual(lines.slice(0, 3).map((l) => l.text), [
    "按第 1 下：digit 是 0，last 灭",
    "按第 2 下：digit 是 1，last 灭",
    "按第 3 下：digit 是 2，last 灭",
  ]);
  assert.equal(lines.at(-1).text, "这时候它记着：count 是 3", "and what it carries into the next press");
});

test("a feeder that stops says so, and one that never stops would have been obvious", () => {
  // The bug that shipped: the plain counter wraps to zero at the top, so the pet gets fed
  // forever. Played out loud, the wrap is right there in the words.
  const wrapping = narrate(program("counter", { top: 3 }), { ticks: 6 });
  assert.ok(wrapping.some((l) => /digit 是 3/.test(l.text)), "it counts up to the top");
  assert.ok(wrapping.some((l, i) => i > 3 && /digit 是 0/.test(l.text)), "and then starts over, in plain sight");

  // The fix: a quota stops. Repeated presses that change nothing are folded into one line,
  // which is exactly the sentence a person needs to see.
  const stopping = narrate(program("quota", { perDay: 3 }), { ticks: 6 });
  assert.ok(stopping.some((l) => /按第 \d+ 到 \d+ 下：都是/.test(l.text)), "pressing on after the limit says 'nothing changes'");
  assert.ok(stopping.at(-1).text.includes("count 是 3"), "and it remembers it is full");
});

test("a lock that shuts itself on a wrong press would have shown up as a lamp going out", () => {
  // Pressing enter with the dial at 0 is a wrong code. The lock must not close on that - the
  // bug that shipped did exactly that, and here it would read as "unlocked 亮" then "unlocked 灭".
  const lock = program("lock", { bits: 6, code: 42 });
  const { steps } = play(lock, { ticks: 3 });
  assert.ok(steps.every((s) => s.outputs.unlocked === 0), "a wrong code never opens it");
  assert.ok(steps.every((s) => s.after.open === 0), "and never changes what it remembers");
});

test("a machine that ignores its only button is called out", () => {
  assert.equal(everMoves(program("counter", { top: 9 })), true);
  assert.equal(everMoves(program("lamp", {})), true);
  // Compare is pure combinational with no 1-bit input: pressing the first input does nothing
  // to its outputs, which is worth knowing before someone waits for it to move.
  assert.equal(everMoves(program("compare", { bits: 4 })), false);
});

test("the narration invents nothing: every number comes from running the program", () => {
  const p = program("traffic", {});
  const { steps } = play(p, { ticks: 4 });
  assert.deepEqual(steps.map((s) => [s.outputs.red, s.outputs.green, s.outputs.yellow]), [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]]);
  const lines = narrate(p, { ticks: 4, lang: "en" });
  assert.match(lines[0].text, /^Press 1: red on, green off, yellow off$/);
  assert.match(lines.at(-1).text, /^It now remembers: phase = 1$/);
});
