// Choosing a shape and setting its knobs: the cheapest road from a sentence to a proven
// circuit, and the one the measurements favour. Nothing here trusts the model - a name it
// invents is dropped, a knob out of range falls back to the default, and whatever survives is
// still compiled and proven on every row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TEMPLATES, fromTemplate, templateDefaults } from "../src/templates.mjs";
import { forkFromReply, forkPrompt, forkQuestion, knobsFromReply, knobsPrompt, safeKnobs } from "../src/route.mjs";
import { compileSpec } from "../src/job.mjs";

test("the fork offers every shape plus a way to say none of them", () => {
  const q = forkQuestion("zh");
  for (const t of TEMPLATES) assert.ok(q.criteria[t.id], `${t.id} is on the list`);
  assert.ok(q.criteria.none, "and so is 'none of these'");
  assert.equal(Object.keys(q.criteria).length, TEMPLATES.length + 1);

  const prompt = forkPrompt("按一下亮，再按一下灭", "zh");
  assert.match(prompt, /按一下亮/);
  assert.match(prompt, /lamp = /);
  assert.match(prompt, /只回答一个英文代号/);
});

test("a shape is read out of whatever the model wraps it in, and an invented one is refused", () => {
  assert.equal(forkFromReply("quota"), "quota");
  assert.equal(forkFromReply('答案是 "traffic"。'), "traffic");
  assert.equal(forkFromReply("I think this is the `elevator` one"), "elevator");
  assert.equal(forkFromReply("none"), "none");
  assert.equal(forkFromReply("一个红绿灯计数器"), null, "a shape that is not on the list is not a shape");
  assert.equal(forkFromReply(""), null);
});

test("knobs are asked for by name and range, and a shape with no knobs is not asked about", () => {
  const prompt = knobsPrompt("quota", "宠物喂食器：按一下出一份，一天最多五份", "zh");
  assert.match(prompt, /perDay/);
  assert.match(prompt, /2 到 7/);
  assert.match(prompt, /一天几份/);
  assert.equal(knobsPrompt("lamp", "一个灯"), null, "the lamp has nothing to turn");
  assert.throws(() => knobsPrompt("nope", "x"), /unknown template/);

  assert.deepEqual(knobsFromReply('```json\n{"perDay": 5}\n```'), { perDay: 5 });
  assert.deepEqual(knobsFromReply('好的：{"top": "9", "junk": "abc"}'), { top: 9 }, "numbers survive, words do not");
  assert.deepEqual(knobsFromReply("没有 JSON"), {}, "an unreadable answer is no knobs, not a crash");
});

test("a knob the template would refuse falls back to its default instead of breaking", () => {
  assert.deepEqual(safeKnobs("quota", { perDay: 5 }), { knobs: { perDay: 5 }, dropped: [] });

  const tooBig = safeKnobs("quota", { perDay: 500 });
  assert.deepEqual(tooBig.knobs, {}, "out of range is dropped");
  assert.equal(tooBig.dropped[0].name, "perDay");
  assert.equal(tooBig.dropped[0].value, 500);

  // The vote template only takes odd numbers of people; an even one is not silently rounded.
  assert.deepEqual(safeKnobs("vote", { people: 4 }).knobs, {}, "off its step is dropped");
  assert.deepEqual(safeKnobs("vote", { people: 5 }).knobs, { people: 5 });
  assert.deepEqual(safeKnobs("counter", { top: 2.5 }).knobs, {}, "not a whole number is dropped");
});

test("whatever the model picks, the circuit that comes out is still proven on every row", () => {
  // The whole safety argument in one test: feed the fork a wrong answer on purpose and the
  // result is still a proven circuit - just not the one the person wanted, which they see in
  // the read-back before anything is built.
  for (const [reply, sentence] of [["quota", "宠物喂食器：按一下出一份，一天最多五份"], ["traffic", "宠物喂食器：按一下出一份，一天最多五份"]]) {
    const id = forkFromReply(reply);
    const { knobs } = safeKnobs(id, knobsFromReply('{"perDay": 5, "top": 99}'));
    const built = fromTemplate(id, knobs, "zh");
    const result = compileSpec("expr", built.spec, { steps: 2000 });
    assert.equal(result.certificate.verification.wrong, 0, `${id}: proven on every row regardless`);
    assert.ok(built.sentence.length > 8, `${id}: and it says what it built, so a wrong pick is visible`);
  }
  assert.deepEqual(safeKnobs("quota", {}).knobs, {}, "no knobs named means the template's own defaults");
  assert.deepEqual(templateDefaults(TEMPLATES.find((t) => t.id === "quota")), { perDay: 5 });
});
