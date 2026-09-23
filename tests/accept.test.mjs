// The accept rule of the scene-rewrite loop: what stops "improve the prompt" from becoming
// "learn to sound sure".
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptRound } from "../tools/accept.mjs";

const round = (o) => ({ unsure: 20, anchorsBroken: [], ruleAgreeSure: null, ofSure: 40, ...o });

test("the first round is the baseline and is always kept", () => {
  assert.deepEqual(acceptRound(null, round({})), { accepted: true, why: "baseline" });
});

test("fewer unsure rows with every anchor intact is an improvement", () => {
  const got = acceptRound(round({ unsure: 20 }), round({ unsure: 12 }));
  assert.equal(got.accepted, true);
});

test("a broken anchor sinks the round however short the review list got", () => {
  const got = acceptRound(round({ unsure: 20 }), round({ unsure: 0, anchorsBroken: [{ row: 3 }] }));
  assert.equal(got.accepted, false);
  assert.match(got.why, /1 anchors broken/);
});

test("a rewrite that changes nothing is not an improvement", () => {
  assert.equal(acceptRound(round({ unsure: 20 }), round({ unsure: 20 })).accepted, false);
  assert.equal(acceptRound(round({ unsure: 20 }), round({ unsure: 21 })).accepted, false);
});

test("where a rule exists, buying confidence by getting the sure rows wrong is refused", () => {
  const before = round({ unsure: 20, ruleAgreeSure: 40, ofSure: 40 });
  const cheaper = round({ unsure: 4, ruleAgreeSure: 50, ofSure: 56 });
  const got = acceptRound(before, cheaper);
  assert.equal(got.accepted, false, "100% -> 89% on the rows it was sure about");
  assert.match(got.why, /100% -> 89%/);
  assert.equal(acceptRound(before, round({ unsure: 4, ruleAgreeSure: 56, ofSure: 56 })).accepted, true);
});

test("without a rule the anchors are the whole guard, and the round still has to shrink the list", () => {
  const before = round({ unsure: 20, ruleAgreeSure: null });
  assert.equal(acceptRound(before, round({ unsure: 10, ruleAgreeSure: null })).accepted, true);
  assert.equal(acceptRound(before, round({ unsure: 10, ruleAgreeSure: null, anchorsBroken: [{ row: 1 }, { row: 2 }] })).accepted, false);
});
