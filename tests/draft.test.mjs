// Reading a drafted codebook back to a person, and pointing at the parts a model gets wrong.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { codebookPrompt, readBack, reviewDraft, settleWidths } from "../src/draft.mjs";

const charger = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));

test("a bucket the caller could not compute is pointed at, and an honest one is not", () => {
  const clean = reviewDraft(charger);
  assert.equal(clean.notes.filter((n) => n.kind === "bucket" && /far side of the wall/.test(n.says)).length, 0,
    "every bucket here is a sensor reading, so nothing should be flagged");

  // The control: a codebook that really does cross the wall must be caught, or the check is
  // decoration. One field per kind of crossing.
  const across = structuredClone(charger);
  across.observe = {
    tone: { width: 1, raw: "sentiment of the message text", values: { 0: "calm", 1: "angry" } },
    who: { width: 1, raw: "whether the customer id is on the allow list", values: { 0: "no", 1: "yes" } },
    rate: { width: 1, raw: "current fx rate from the pricing API", values: { 0: "low", 1: "high" } },
    when: { width: 1, raw: "the current time of day", values: { 0: "day", 1: "night" } },
  };
  across.rule = "tone == 1 ? stop : full";
  const flagged = reviewDraft(across).notes.filter((n) => /far side of the wall/.test(n.says));
  assert.equal(flagged.length, 4, "all four crossings are caught");
  assert.deepEqual(flagged.map((n) => n.about).sort(), ["rate", "tone", "when", "who"]);
  assert.match(flagged.find((n) => n.about === "tone").says, /reads free text/);
  assert.match(flagged.find((n) => n.about === "who").says, /who someone is/);
  assert.match(flagged.find((n) => n.about === "rate").says, /calls out/);
  assert.match(flagged.find((n) => n.about === "when").says, /clock/);
});

// The noun is not the crossing. A decision about comments says "comment" in every description;
// only the bucket that needs someone to READ one is on the far side.
test("a decision about text does not flag every field just for naming its subject", () => {
  const spec = JSON.parse(readFileSync(new URL("../examples/comment-hold.decision.json", import.meta.url), "utf8"));
  const flagged = reviewDraft(spec).notes.filter((n) => /far side of the wall/.test(n.says)).map((n) => n.about);
  assert.deepEqual(flagged, ["tone"], "only 'how the comment is written' needs anyone to read one");
  for (const field of ["provoked", "history"]) {
    assert.ok(!flagged.includes(field), `${field} is a stored flag, not a reading of anything`);
  }
});

test("safe is always raised, because it is the field a model reads the wrong way", () => {
  const note = reviewDraft(charger).notes.find((n) => n.kind === "safe");
  assert.match(note.says, /"stop"/);
  assert.match(note.says, /least damaging/);
  assert.match(note.says, /NOT "which is usually right"/);
});

test("the read-back is sentences, not JSON, and says which codes fail closed", () => {
  const text = readBack(charger);
  assert.match(text, /charge-throttle: 8 bits, 192 legal situations of 256/);
  assert.match(text, /cycles {2}\(1 unused code, which review by construction\)/);
  assert.match(text, /stop {2}\(the safe one\)/);
  assert.doesNotMatch(text, /[{}]/, "a person should not have to read JSON to check it");
});

test("the drafting prompt carries the two things a model gets wrong", () => {
  const p = codebookPrompt("Whether to page someone | severity, time_open | page, wait");
  assert.match(p, /Whether to page someone/);
  assert.match(p, /LEAST DAMAGE/, "safe is the field that needs saying twice");
  assert.match(p, /WITHOUT reading free text, identifying a person, calling the network, or looking at a clock/);
});

// Width is counting, not meaning. The exact failure a 7B model made twice running: three phrased
// codes squeezed into one bit.
test("a width too small for its phrased codes is widened, said out loud, and nothing else moves", () => {
  const draft = structuredClone(charger);
  const first = Object.keys(draft.observe)[0];
  draft.observe[first].width = 1;
  draft.observe[first].values = { 0: "cool", 1: "warm", 2: "hot" };
  const { spec, fixed } = settleWidths(draft);
  assert.deepEqual(fixed, [{ field: first, from: 1, to: 2 }]);
  assert.equal(spec.observe[first].width, 2);
  assert.deepEqual(spec.observe[first].values, draft.observe[first].values, "phrases are untouched");
  assert.equal(draft.observe[first].width, 1, "the draft passed in is not mutated");

  // A generous width is a choice, not a mistake, and is left as it is.
  const roomy = structuredClone(charger);
  roomy.observe[first].width = 3;
  roomy.observe[first].values = { 0: "cool", 1: "warm" };
  assert.deepEqual(settleWidths(roomy).fixed, []);
  assert.equal(settleWidths(roomy).spec.observe[first].width, 3);
});

// The miss the wall check owns up to, seen on the first real draft: a description that names no
// source at all. It is not flagged as crossing the wall - it is asked to say what it reads.
test("a bucket that names no source is asked where its value comes from", () => {
  const draft = structuredClone(charger);
  const [first, second] = Object.keys(draft.observe);
  draft.observe[first].raw = "based on the current state of the street";
  draft.observe[second].raw = "";
  const notes = reviewDraft(draft).notes;
  const vague = notes.filter((n) => n.kind === "vague").map((n) => n.about);
  assert.deepEqual(vague, [first, second]);
  assert.match(notes.find((n) => n.about === first && n.kind === "vague").says, /does not say where its value comes from/);
  assert.equal(notes.filter((n) => /far side of the wall/.test(n.says)).length, 0, "vague is not the same accusation as crossing the wall");
  assert.equal(reviewDraft(charger).notes.filter((n) => n.kind === "vague").length, 0, "real sensor readings are not vague");
});
