// The parts of the chat-model filler that can silently corrupt a measurement: reading the
// answer out of a chatty reply, and describing what a set of confidences is made of.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { askText, budget, chatFiller, majorityFiller, spread } from "../tools/chat-filler.mjs";
import { decodeRow, parseDecision, situation } from "../src/decision.mjs";

const spec = JSON.parse(readFileSync(new URL("../examples/comment-hold.decision.json", import.meta.url), "utf8"));
const d = parseDecision(spec);

test("the question shows the scene, the situation in the codebook's words, and no bits", () => {
  const codes = { tone: 1, target: 2, provoked: 0, history: 2, stakes: 0 };
  const text = askText(d, situation(d, codes));
  assert.match(text, /sarcastic or mocking/);
  assert.match(text, /aimed at a particular person/);
  assert.match(text, /fold: fold it behind a click/);
  assert.doesNotMatch(text, /\b(bit|code|width|0b)\b/i, "a model must never be shown the encoding");
  const other = askText(d, situation(d, codes), "A different forum entirely.");
  assert.match(other, /A different forum entirely\./);
  assert.doesNotMatch(other, /public discussion forum/, "an overriding scene replaces the spec's own");
});

test("a budget is spent once per attempt and refuses past its cap", () => {
  const b = budget(2);
  assert.equal(b.take(), 1);
  assert.equal(b.take(), 2);
  assert.throws(() => b.take(), /budget of 2 is spent/);
  assert.equal(b.used, 2);
  assert.equal(b.left, 0);
});

test("the spread of a set of confidences says whether the number carries information", () => {
  const flat = spread(Array.from({ length: 50 }, () => 0.9));
  assert.equal(flat.distinct, 1);
  assert.equal(flat.modalShare, 1);
  const varied = spread([0.9, 0.9, 0.8, 0.7, 0.55, 0.3]);
  assert.equal(varied.distinct, 5);
  assert.ok(varied.modalShare < 0.9);
  assert.equal(varied.modal, 0.9);
  assert.deepEqual(spread([]), { n: 0, distinct: 0, modal: null, modalShare: 0, top: [] });
});

// The filler goes through a child process, so these exercise it against a stubbed runner by
// swapping the module's spawn point is not possible - instead the parser is exercised through
// the shapes a chat model actually returns, which is where the risk is.
test("the answer is read out of a chatty reply, and a reply that is not an answer is an error", async () => {
  const codes = decodeRow(d, 0);
  const replies = [
    '{"choice": "fold", "confidence": 0.62}',
    'Thinking about it...\n{"choice":"fold","confidence":0.62}\n',
    '\u001b[0m> build · model\u001b[0m\n```json\n{"choice": "fold", "confidence": 0.62}\n```\n',
    'First I considered {"note": "not an answer"} and then decided.\n{"choice": "fold", "confidence": 0.62}',
  ];
  for (const reply of replies) {
    const filler = chatFiller(d, { model: "m", cwd: ".", spend: budget(3), run: async () => reply });
    const got = await filler(codes, situation(d, codes), d);
    assert.deepEqual({ choice: got.choice, confidence: got.confidence }, { choice: "fold", confidence: 0.62 }, JSON.stringify(reply));
  }

  const bad = {
    "no JSON at all": "I would fold this comment.",
    "a choice the codebook never declared": '{"choice": "ban", "confidence": 0.9}',
    "a confidence that is not a number in 0..1": '{"choice": "fold", "confidence": "high"}',
  };
  for (const [why, reply] of Object.entries(bad)) {
    const filler = chatFiller(d, { model: "m", cwd: ".", spend: budget(3), run: async () => reply, retries: 0 });
    await assert.rejects(() => filler(codes, situation(d, codes), d), why);
  }
});

test("a failing call is retried within the budget and gives up when the budget is gone", async () => {
  const codes = decodeRow(d, 0);
  let tries = 0;
  const flaky = async () => { tries += 1; if (tries < 3) throw new Error("provider said 500"); return '{"choice":"keep","confidence":0.9}'; };
  const got = await chatFiller(d, { model: "m", cwd: ".", spend: budget(5), run: flaky })(codes, situation(d, codes), d);
  assert.equal(got.choice, "keep");
  assert.equal(tries, 3);

  const spend = budget(1);
  await assert.rejects(() => chatFiller(d, { model: "m", cwd: ".", spend, run: async () => { throw new Error("provider said 500"); } })(codes, situation(d, codes), d), /500/);
  assert.equal(spend.used, 1, "it does not keep spending after the cap");
});

test("asking a situation several times: the confidence is how often the model agreed with itself", async () => {
  const codes = decodeRow(d, 0);
  const sit = situation(d, codes);
  const canned = (...answers) => { let i = 0; return async () => answers[i++ % answers.length]; };

  // All three agree: actionable, whatever the model said about its own certainty. That is the
  // point - the self-report was measured to buy nothing and to cost half the actionable rows.
  const unsure = await majorityFiller(canned({ choice: "fold", confidence: 0.4 }, { choice: "fold", confidence: 0.45 }, { choice: "fold", confidence: 0.4 }), 3)(codes, sit, d);
  assert.equal(unsure.choice, "fold");
  assert.equal(unsure.confidence, 1, "three of three agreeing is full agreement");
  assert.ok(unsure.confidence >= d.threshold, "and so it is actionable despite the model hedging");
  assert.equal(unsure.selfReport, 0.417, "what the model claimed is kept, just not used to decide");

  // Two of three: the model cannot make its mind up, so the row reviews however sure it sounds.
  const split = await majorityFiller(canned({ choice: "fold", confidence: 0.99 }, { choice: "keep", confidence: 0.99 }, { choice: "fold", confidence: 0.99 }), 3)(codes, sit, d);
  assert.equal(split.choice, "fold", "two of three");
  assert.ok(split.confidence < d.threshold, `a model that cannot make its mind up must land under the threshold, got ${split.confidence}`);
  assert.deepEqual(split.asks.map((a) => a.choice), ["fold", "keep", "fold"], "every ask is kept");
  assert.equal(split.agreement, 2 / 3);

  // The rule that was replaced is still reachable, because tests and re-scoring need it.
  const old = await majorityFiller(canned({ choice: "fold", confidence: 0.4 }, { choice: "fold", confidence: 0.45 }, { choice: "fold", confidence: 0.4 }), 3, { rule: "self-report" })(codes, sit, d);
  assert.ok(old.confidence < d.threshold, "under the old rule a hedging model kept the row out");
  assert.throws(() => majorityFiller(() => {}, 3, { rule: "vibes" }), /must be "agreement" or "self-report"/);
  assert.throws(() => majorityFiller(() => {}, 0), /whole number of asks/);
});
