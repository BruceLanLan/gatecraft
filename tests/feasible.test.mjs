// The gate in front of everything: can a circuit hold this at all? The verdict is decided by
// code from a named list of signals, so these tests are exact - no model, no sampling, no
// "usually". If a refusal here were ever wrong, the whole promise would be a guess.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KINDS, MAX_BITS, feasibility, refusalWords, signalsFromReply, signalsPrompt } from "../src/feasible.mjs";

const io = (inputs, outputs, remembers = []) => ({ inputs, outputs, remembers });
const bit = (name) => ({ name, kind: "bit" });
const num = (name, min, max) => ({ name, kind: "number", min, max });

test("what a circuit can hold is decided by the kinds, and only two kinds can be held", () => {
  assert.deepEqual(
    Object.entries(KINDS).filter(([, k]) => k.finite).map(([id]) => id),
    ["bit", "number"],
    "a switch and a bounded number; everything else is a refusal",
  );
  for (const [id, k] of Object.entries(KINDS)) assert.ok(k.zh && k.en, `${id} says what it is in both languages`);
});

test("the five sentences no circuit can do are refused, each naming what blocked it", () => {
  const cases = [
    ["做一个聊天室", io([{ name: "消息", kind: "text" }], [{ name: "聊天记录", kind: "list" }]), "text"],
    ["给我做一个待办清单", io([{ name: "新事项", kind: "text" }], [{ name: "清单", kind: "list" }]), "text"],
    ["记账本：记录每天花了多少钱", io([num("花了多少", 0, 10000)], [{ name: "每天的流水", kind: "list" }]), "list"],
    ["把这段文字翻译成英文", io([{ name: "中文句子", kind: "text" }], [{ name: "英文句子", kind: "text" }]), "text"],
    ["扫码点餐的小程序", io([{ name: "扫到的码", kind: "text" }], [{ name: "订单", kind: "list" }]), "text"],
  ];
  for (const [sentence, signals, blocker] of cases) {
    const verdict = feasibility(signals);
    assert.equal(verdict.ok, false, sentence);
    assert.equal(verdict.no, true, `${sentence}: a real refusal, not a question`);
    assert.equal(verdict.impossible[0].kind, blocker, sentence);
    assert.match(refusalWords(verdict), /做不了/, sentence);
    assert.match(refusalWords(verdict), new RegExp(verdict.impossible[0].name), "the refusal names the thing that blocked it");
  }
});

test("the shapes a circuit can hold are let through, with their width counted", () => {
  const vote = feasibility(io([bit("评委1"), bit("评委2"), bit("评委3")], [bit("通过")]));
  assert.equal(vote.ok, true);
  assert.equal(vote.bits, 3);

  const thermostat = feasibility(io([num("温度", 0, 63)], [bit("暖气")], [bit("正在加热")]));
  assert.equal(thermostat.ok, true);
  assert.equal(thermostat.bits, 7, "six bits of reading and one bit remembered");

  // Outputs are not charged against the input ceiling: a display can be wide.
  const digit = feasibility(io([num("数字", 0, 9)], [num("七段", 0, 127)]));
  assert.equal(digit.ok, true);
  assert.equal(digit.bits, 4);
});

test("a number with no range is refused, which is how a wish without a number is caught", () => {
  // "温度自动调到最舒服" - the model is most eager to guess exactly here, so the gate refuses
  // before anything is built and the person is asked what "comfortable" means in degrees.
  const verdict = feasibility(io([{ name: "温度", kind: "number" }], [bit("暖气")]));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ask, true, "a missing number is a question, never a refusal");
  assert.equal(verdict.no, false);
  assert.equal(verdict.questions[0].why, "no-range");
  assert.equal(refusalWords(verdict), "输入「温度」从几到几？", "one question, on its own");

  assert.equal(feasibility(io([num("温度", 5, 5)], [bit("暖气")])).questions[0].why, "no-range", "a range of nothing is no range");
});

test("too wide is refused, and says so as a width rather than as a no", () => {
  const verdict = feasibility(io([num("投入的分", 0, 9999), num("价格", 0, 9999)], [num("找零", 0, 9999)]));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems[0].why, "too-wide");
  assert.match(refusalWords(verdict), /把数的范围放小一点/, "it points at the way out");
  assert.doesNotMatch(refusalWords(verdict), /做不了/, "a wide circuit is not an impossible one");

  const just = feasibility(io([num("a", 0, 1023), num("b", 0, 1023)], [bit("大于")]));
  assert.equal(just.bits, MAX_BITS);
  assert.equal(just.ok, true, "exactly at the ceiling still fits");
});

test("a thing with nothing going in, or nothing coming out, is not a machine", () => {
  assert.equal(feasibility(io([], [bit("灯")])).questions[0].why, "nothing-in");
  assert.equal(feasibility(io([bit("按钮")], [])).questions[0].why, "nothing-out");
  assert.equal(feasibility(io([], [bit("灯")])).no, false, "an incomplete panel is a question, not an impossibility");
  // Something that only remembers still counts as having something going in.
  assert.equal(feasibility(io([], [bit("灯")], [bit("相位")])).ok, true);
});

test("an unknown kind is refused rather than assumed to be fine", () => {
  const verdict = feasibility(io([{ name: "东西", kind: "blob" }], [bit("灯")]));
  assert.equal(verdict.questions[0].why, "unknown-kind");
  assert.equal(verdict.no, false, "a kind we do not recognise is not a proof of impossibility");
  assert.match(refusalWords(verdict), /没说清是什么东西/);
});

test("the prompt asks only for names and kinds, and the reply is read from prose or a fence", () => {
  const prompt = signalsPrompt("按一下亮，再按一下灭");
  assert.match(prompt, /按一下亮，再按一下灭/);
  assert.match(prompt, /Do not judge whether it is possible/, "the judging is not the model's job");
  for (const kind of Object.keys(KINDS)) assert.ok(prompt.includes(`  ${kind}`), `${kind} is offered`);
  assert.throws(() => signalsPrompt("  "), /describe the behaviour/);

  const signals = signalsFromReply('好的：\n```json\n{"inputs":[{"name":"按钮","kind":"bit"}],"outputs":[{"name":"灯","kind":"bit"}]}\n```');
  assert.equal(signals.inputs[0].name, "按钮");
  assert.deepEqual(signals.remembers, [], "a missing list reads as empty, not as a crash");
  assert.equal(feasibility(signals).ok, true);
  assert.equal(signalsFromReply('{"inputs":[],"state":[{"name":"count","kind":"bit"}],"outputs":[]}').remembers.length, 1, '"state" is accepted for "remembers"');
  assert.throws(() => signalsFromReply("没有 JSON"), /no JSON object/);
});

test("only the unbounded kinds can make it a no; everything else is a question", () => {
  // The split that matters: "no" is exactly the class that is true of every circuit, so it can
  // be called a proof. Measured on two models, keeping width and missing ranges out of "no"
  // took the buildable sentences let through from seven of fifteen to thirteen, with the
  // refusals still perfect.
  for (const [kind, k] of Object.entries(KINDS)) {
    const v = feasibility(io([{ name: "x", kind, min: 0, max: 7 }], [bit("灯")]));
    assert.equal(v.no, !k.finite, `${kind}: only an unbounded kind is a refusal`);
    if (!k.finite) assert.equal(v.questions.length, 0, `${kind}: a refusal is not also a question`);
  }
  // An impossible signal outranks a question: there is no point asking about a width when the
  // thing can never be built at all.
  const both = feasibility(io([{ name: "消息", kind: "text" }, { name: "计数", kind: "number" }], [bit("灯")]));
  assert.equal(both.no, true);
  assert.equal(both.ask, false);
  assert.match(refusalWords(both), /做不了/);
});

test("a refusal that has a standard way round it says so", () => {
  // "一天最多五份" really does want to know the date, and no circuit knows the date. Measured
  // on a strong model this was the one honest refusal left, and the way every such machine
  // actually solves it is a button for the new day - so the refusal offers that.
  const feeder = feasibility(io([bit("喂食按钮"), { name: "当前日期", kind: "time" }], [num("今日已出", 0, 5)]));
  assert.equal(feeder.no, true, "a clock is genuinely out of reach");
  assert.match(refusalWords(feeder), /新的一天/, "and the refusal offers the button that replaces it");

  assert.match(refusalWords(feasibility(io([{ name: "订单", kind: "list" }], [bit("灯")]))), /改成一个计数/);
  assert.match(refusalWords(feasibility(io([{ name: "口味", kind: "text" }], [bit("灯")]))), /几个按钮或一个编号/);
  // Nothing is invented for the two that have no honest substitute.
  assert.doesNotMatch(refusalWords(feasibility(io([{ name: "汇率", kind: "network" }], [bit("灯")]))), /可以改成/);
});

test("a refusal whose every blocker has a stand-in is one swap away, not dead", () => {
  // The pet feeder is the case that taught this: every strong model names "today's date" for
  // "five a day", and every one of them is right - a circuit cannot know the date. What it
  // can have is a button for the new day, so the refusal carries that as an offer.
  const feeder = feasibility(io([bit("按钮"), { name: "当前日期", kind: "time" }], [num("已出", 0, 5)]));
  assert.equal(feeder.no, true, "the signals as named really cannot be held");
  assert.equal(feeder.swappable, true, "but nothing blocking it is without a stand-in");
  assert.equal(feeder.swaps.length, 1);
  assert.equal(feeder.swaps[0].says, "把「当前日期」改成一个手按的「新的一天」按钮");

  // Two blockers, one with no honest substitute: no offer, because half an offer is a lie.
  const online = feasibility(io([{ name: "汇率", kind: "network" }, { name: "备注", kind: "text" }], [bit("灯")]));
  assert.equal(online.no, true);
  assert.equal(online.swappable, false, "an exchange rate cannot be swapped for anything");

  // Three hundred real wishes killed the general version of this offer. Having a stand-in in
  // principle is not the same as the wish surviving it: "把「梦境捕捉器」改成只数个数" was
  // being offered with a straight face. Only the case that has been shown to work is offered.
  const dream = feasibility(io([{ name: "梦境捕捉器", kind: "list" }], [{ name: "放给我看", kind: "text" }]));
  assert.equal(dream.no, true);
  assert.equal(dream.swappable, false, "a dream recorder is not a counter with a different label");

  // Time blockers plus something that needs hands: swapping the clock does not rescue it.
  const catsitter = feasibility(io([{ name: "上班时间", kind: "time" }], [{ name: "逗猫棒", kind: "bit", wiring: "actuator" }]));
  assert.equal(catsitter.swappable, false, "no offer when the machine would still need hands");

  assert.equal(feasibility(io([bit("按钮")], [bit("灯")])).swappable, false, "nothing to swap when nothing is blocked");
});

test("a wish whose logic fits but which needs eyes or hands is its own answer", () => {
  // A hundred real wishes showed the hole: "帮我剥蒜" and "一打呼就让他翻个身" name perfectly
  // good bits, fit in twenty bits, and are impossible for us. The kinds could not see it,
  // so both sailed through and were caught only by accident, further down.
  const snore = feasibility(io([{ name: "打呼", kind: "bit", wiring: "sensor" }], [{ name: "震动", kind: "bit", wiring: "actuator" }]));
  assert.equal(snore.ok, false, "we cannot deliver this");
  assert.equal(snore.no, false, "but the logic is not impossible - that distinction is the point");
  assert.equal(snore.needsHardware, true);
  assert.equal(snore.hardware.length, 2, "both the ear and the hand are named");
  assert.match(snore.hardware[0].says, /感知真实世界/);

  const buttons = feasibility(io([{ name: "按钮", kind: "bit", wiring: "button" }], [{ name: "灯", kind: "bit", wiring: "lamp" }]));
  assert.equal(buttons.ok, true, "a button and a lamp is exactly what we can deliver");
  assert.equal(buttons.needsHardware, false);

  // Old callers that never said how anything is wired are unaffected.
  assert.equal(feasibility(io([bit("按钮")], [bit("灯")])).ok, true);

  // Needing hardware outranks a missing number: asking how high the score goes is a silly
  // question to put to a machine that would first have to hear the drill upstairs. Without
  // this order a third of the sensor wishes landed in "just one question away".
  const drill = feasibility(io([{ name: "电钻声", kind: "bit", wiring: "sensor" }], [{ name: "音量", kind: "number", wiring: "actuator" }]));
  assert.equal(drill.needsHardware, true, "the ears and the hands come first");
  assert.equal(drill.ask, false, "even though the volume has no range given");

  // Something impossible AND needing hardware is still impossible: no is the stronger answer.
  const cat = feasibility(io([{ name: "猫叫", kind: "text", wiring: "sensor" }], [{ name: "它想干嘛", kind: "text", wiring: "display" }]));
  assert.equal(cat.no, true);
  assert.equal(cat.needsHardware, false, "no outranks needs-hardware");
});
