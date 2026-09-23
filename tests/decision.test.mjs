// A decision: codebook in, proven circuit out, and the fail-closed edges checked on every row.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { booleanIrFiles } from "../src/boolean-ir.mjs";
import { majorityFiller } from "../tools/chat-filler.mjs";
import { drawAnchors } from "../src/anchors.mjs";
import { applyOverrides, calibrateThreshold, checkAnchors, decide, decodeRow, encodeRow, decisionPinNames, decisionTable, fillDecision, freezeDecision, jevFiller, parseDecision, isLegal, phrasesOf, reviewRows, ruleFiller, ruleText, situation } from "../src/decision.mjs";
import { evaluateTable } from "../src/verify.mjs";
import { proveWithYosys, yosysAvailable } from "../src/yosys.mjs";

const spec = JSON.parse(readFileSync(new URL("../examples/mario-jump.decision.json", import.meta.url), "utf8"));
const mario = () => parseDecision(spec);
const REACH = (speed) => speed + 1;
const truth = (c) => (c.on_ground && ((c.gap_ahead > 0 && c.gap_ahead <= REACH(c.speed)) || (c.enemy_ahead > 0 && c.enemy_ahead <= REACH(c.speed))) ? "jump" : "no");

test("the codebook is checked and hashed; the same contract always has the same hash", () => {
  const d = mario();
  assert.equal(d.nIn, 9);
  assert.equal(d.actionBits, 1);
  assert.equal(d.codebookSha256.length, 64);
  assert.equal(parseDecision(spec).codebookSha256, d.codebookSha256);
  const changed = structuredClone(spec);
  changed.observe.speed.values["2"] = "sprinting";
  assert.notEqual(parseDecision(changed).codebookSha256, d.codebookSha256, "a changed phrase is a different contract");
  assert.throws(() => parseDecision({ ...spec, act: { choices: spec.act.choices, safe: "fly" } }), /act.safe/);
  assert.throws(() => parseDecision({ ...spec, observe: { ...spec.observe, speed: { width: 2, values: { 0: "stopped", 5: "too big" } } } }), /does not fit/);
  assert.throws(() => parseDecision({ ...spec, observe: { wide: { width: 8, values: { 0: "a", 1: "b" } }, wider: { width: 8, values: { 0: "a", 1: "b" } }, more: { width: 1, values: { 0: "a", 1: "b" } } } }), /17 bits/);
});

test("a stated rule fills the table without asking anyone, and the circuit answers every legal row as the rule does", async () => {
  const d = mario();
  const fill = await fillDecision(d, ruleFiller(d, spec.rule));
  const frozen = freezeDecision(d, fill, { steps: 500 });
  const counts = frozen.certificate.decision.rows;
  assert.equal(counts.illegal, 128, "speed code 3 makes a quarter of the rows illegal");
  assert.equal(counts.rule, 384);
  assert.equal(counts.review, 128, "only the illegal rows review");
  assert.equal(frozen.certificate.verification.wrong, 0);
  for (let row = 0; row < 512; row++) {
    const codes = Object.fromEntries(d.fields.map((f, i) => [f.field, [(row >>> 0) & 7, (row >>> 3) & 7, (row >>> 6) & 1, (row >>> 7) & 3][i]]));
    const got = decide(frozen, codes);
    if (codes.speed === 3) {
      assert.equal(got.review, 1, `illegal row ${row} reviews by construction`);
      assert.equal(got.action, "no", `illegal row ${row} answers the safe action`);
      assert.equal(got.legal, false);
    } else {
      assert.equal(got.review, 0);
      assert.equal(got.action, truth(codes), `row ${row}`);
    }
  }
});

// A stand-in for the decision model: right on the rule, sure when far from its edge and
// unsure near it, and it never sees the illegal rows.
const fakeJev = (asked) => (codes) => {
  asked.push(codes);
  const edge = Math.min(Math.abs(codes.gap_ahead - REACH(codes.speed)), Math.abs(codes.enemy_ahead - REACH(codes.speed)));
  return { choice: truth(codes), confidence: edge === 0 ? 0.4 : 0.95, source: "jev" };
};

test("model answers below the threshold review; a person's override clears exactly those rows", async () => {
  const d = mario();
  const asked = [];
  const fill = await fillDecision(d, fakeJev(asked));
  assert.equal(asked.length, 384, "illegal rows were never asked");
  assert.ok(asked.every((c) => c.speed !== 3));
  const table = decisionTable(d, fill);
  assert.equal(table.counts.jev, 384);
  const unsure = reviewRows(d, fill);
  assert.ok(unsure.length > 0 && unsure.length < 384);
  assert.ok(unsure.every((r) => r.confidence < 0.7));
  assert.equal(table.counts.review, 128 + unsure.length);
  for (const r of unsure) assert.equal(r.situation.speed, spec.observe.speed.values[String(r.given.speed)], "review rows are shown in the codebook's words");

  // The person confirms two of them and overrides one against the model.
  const first = unsure[0], second = unsure[1], third = unsure[2];
  const overrides = { codebook: d.codebookSha256, rows: [
    { given: first.given, choice: first.model },
    { given: second.given, choice: second.model },
    { given: third.given, choice: third.model === "jump" ? "no" : "jump", note: "too close to call; stay safe" },
  ] };
  const frozen = freezeDecision(d, fill, { overrides, steps: 500 });
  assert.equal(frozen.certificate.decision.rows.human, 3);
  assert.equal(frozen.certificate.decision.rows.review, 128 + unsure.length - 3);
  assert.equal(decide(frozen, first.given).review, 0);
  assert.equal(decide(frozen, third.given).action, third.model === "jump" ? "no" : "jump");
  assert.equal(decide(frozen, third.given).review, 0);
  const still = unsure.find((r) => ![first, second, third].includes(r));
  assert.equal(decide(frozen, still.given).review, 1, "an unconfirmed low-confidence row still reviews");
  assert.equal(decide(frozen, still.given).action, still.model, "but carries the model's action for whoever chooses to read it");

  // Overrides written against another codebook are refused, and an illegal situation cannot be overridden.
  assert.throws(() => applyOverrides(d, fill, { codebook: "0".repeat(64), rows: [] }), /codebook/);
  assert.throws(() => applyOverrides(d, fill, { codebook: d.codebookSha256, rows: [{ given: { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 3 }, choice: "no" }] }), /illegal/);
});

test("the frozen table is what the certificate says: action bits then review, on every row", async () => {
  const d = mario();
  const fill = await fillDecision(d, fakeJev([]));
  const frozen = freezeDecision(d, fill, { steps: 500 });
  const ys = evaluateTable(frozen.circuit);
  assert.equal(ys.length, 512);
  for (let row = 0; row < 512; row++) assert.equal(ys[row] >>> 0, frozen.table.ys[row] >>> 0, `row ${row}`);
  assert.equal(frozen.certificate.decision.codebookSha256, d.codebookSha256);
  assert.equal(frozen.certificate.decision.fillSha256.length, 64);
});

test("the decision model filler speaks the provider's shape and never sends illegal rows; a failure is a row, not a crash", async () => {
  const d = mario();
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.equal(body.model, "typesafe/jev");
    assert.equal(body.input.questions.q.instructions, d.question);
    assert.deepEqual(Object.keys(body.input.questions.q.criteria), ["no", "jump"]);
    assert.ok(typeof body.input.state.speed === "string" && body.input.state.speed !== "(illegal code 3)");
    if (body.input.state.gap_ahead === "a gap 5 tiles ahead") return { status: 500, json: async () => ({}) };
    return { status: 200, json: async () => ({ result: { result: { answers: { q: { choice: body.input.state.on_ground.includes("mid-air") ? "no" : "jump", confidence: 0.9 } } } } }) };
  };
  const fill = await fillDecision(d, jevFiller(d, { account: "acct", token: "tok", fetch, retries: 0 }), { concurrency: 4 });
  assert.equal(calls.length, 384);
  assert.equal(fill.rows.filter((r) => r.source === "failed").length, 48, "the rows the provider refused are marked, one per situation");
  assert.equal(fill.rows.filter((r) => r.source === "jev").length, 336);
  const table = decisionTable(d, fill);
  assert.equal(table.counts.failed, 48);
  assert.equal(table.counts.review, 128 + 48, "failed rows review and answer the safe action");
  assert.throws(() => jevFiller(d, { account: "", token: "" }), /CLOUDFLARE/);
});

test("Yosys proves the frozen decision equal to its table, with the codebook's pin names", { skip: yosysAvailable() ? false : "yosys is not installed" }, async () => {
  const d = mario();
  const fill = await fillDecision(d, ruleFiller(d, spec.rule));
  const frozen = freezeDecision(d, fill, { steps: 500 });
  const files = booleanIrFiles(d.name, frozen, { names: decisionPinNames(d) });
  assert.match(files["spec.blif"], /\.outputs y0_action y1_review/);
  assert.match(files["circuit.blif"], /\.inputs x0_gap_ahead0 x1_gap_ahead1 x2_gap_ahead2 x3_enemy_ahead0/);
  const result = proveWithYosys(files);
  assert.ok(result.proven, result.log.split("\n").slice(-6).join(" | "));
});

// The scene-rewrite loop is only legitimate because rewriting HOW a situation is asked is not
// changing WHAT was promised. That rests entirely on the codebook hash ignoring the scene. If
// someone ever folds the scene into it, the loop silently becomes contract mutation, so pin it.
test("the scene is how you ask, not what you promised: rewriting it keeps the same codebook hash", () => {
  const d = mario();
  const reworded = parseDecision({ ...spec, scene: "Completely different words describing the same game, at a length nothing else in this file has." });
  assert.equal(reworded.codebookSha256, d.codebookSha256, "the scene must stay out of the contract hash");
  const codes = { gap_ahead: 2, enemy_ahead: 0, on_ground: 1, speed: 1 };
  assert.notEqual(situation(reworded, codes).scene, situation(d, codes).scene, "but the situation put to a model does change");
  assert.deepEqual(phrasesOf(reworded, codes), phrasesOf(d, codes), "and the words for the codes do not");

  // Anything that IS the contract must move the hash.
  const other = parseDecision({ ...spec, act: { choices: { no: "do not jump now", jump: "leap now" }, safe: "no" } });
  assert.notEqual(other.codebookSha256, d.codebookSha256);
});

// Anchors a person settled before any model ran. A frozen table may contradict one - people
// change their minds - but it must never do so quietly.
test("freezing against anchors says which held and which the table contradicts", async () => {
  const d = mario();
  const anchorFile = JSON.parse(readFileSync(new URL("../examples/mario-jump.anchors.json", import.meta.url), "utf8"));
  const fill = await fillDecision(d, ruleFiller(d, spec.rule));
  const frozen = freezeDecision(d, fill, { steps: 500 });

  const clean = checkAnchors(d, frozen, anchorFile);
  assert.equal(clean.checked, 9);
  assert.equal(clean.broken, 0, "the rule's own table agrees with every anchor drawn from that rule");
  assert.equal(clean.codebook, d.codebookSha256);
  assert.ok(clean.anchors.every((a) => a.got !== null && a.reviewing === false));

  // An anchor the table really does contradict is reported, with the words a person wrote.
  const contrary = { anchors: [{ given: { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 }, choice: "no", why: "never jump at a gap" }] };
  const caught = checkAnchors(d, frozen, contrary);
  assert.equal(caught.broken, 1);
  assert.deepEqual({ got: caught.anchors[0].got, allow: caught.anchors[0].allow, why: caught.anchors[0].why }, { got: "jump", allow: ["no"], why: "never jump at a gap" });

  // A set of defensible answers is honoured, and a nonsense anchor is refused rather than passed.
  assert.equal(checkAnchors(d, frozen, { anchors: [{ given: { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 }, allow: ["no", "jump"] }] }).broken, 0);
  assert.throws(() => checkAnchors(d, frozen, { anchors: [{ given: { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 }, choice: "fly" }] }), /names no choice/);
  assert.throws(() => checkAnchors(d, frozen, { anchors: [{ given: { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 3 }, choice: "no" }] }), /illegal situation/);
});

// A rule may name its choices. Writing their codes instead is a trap: a code means what it
// does only because of the order act.choices happens to be written in.
test("a rule can name its choices, and then reordering the choice list cannot change what it means", async () => {
  const charger = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));
  const d = parseDecision(charger);
  assert.equal(ruleText(d, "swelling == 1 ? stop : full"), "swelling == 1 ? 0 : 2");
  assert.equal(ruleText(d, "soc == 3 ? 1 : 2"), "soc == 3 ? 1 : 2", "codes still work");

  const swollen = { temp: 3, soc: 0, cable: 1, cycles: 0, swelling: 1 };
  const reordered = parseDecision({ ...charger, act: { choices: { full: charger.act.choices.full, slow: charger.act.choices.slow, stop: charger.act.choices.stop }, safe: "stop" } });
  assert.equal(ruleFiller(d, charger.rule)(swollen).choice, "stop");
  assert.equal(ruleFiller(reordered, charger.rule)(swollen).choice, "stop", "the named rule survives the reorder");
  assert.equal(ruleFiller(reordered, "swelling == 1 || temp == 3 ? 0 : 1")(swollen).choice, "full", "the numeric one does not, which is why naming exists");

  // The whole table still compiles and every legal row answers as the rule does.
  const fill = await fillDecision(d, ruleFiller(d, charger.rule));
  const frozen = freezeDecision(d, fill, { steps: 500 });
  assert.equal(frozen.certificate.verification.wrong, 0);
  assert.equal(frozen.certificate.decision.rows.illegal, 64, "cycles code 3 is illegal");
  assert.equal(decide(frozen, swollen).action, "stop");
  assert.equal(decide(frozen, { temp: 0, soc: 1, cable: 1, cycles: 0, swelling: 0 }).action, "full");
  assert.equal(decide(frozen, { temp: 0, soc: 1, cable: 1, cycles: 3, swelling: 0 }).review, 1, "an unknown wear code reviews and stops");

  // A name that is both a field and a choice is an error rather than a silent substitution.
  const clash = { ...charger, observe: { ...charger.observe, stop: { width: 1, values: { 0: "no", 1: "yes" } } } };
  assert.throws(() => ruleText(parseDecision(clash), "stop == 1 ? 0 : 2"), /both an observed field and a choice/);
});

// A fill has to carry how it was made. Rows answered once each were measured not to
// reproduce, and whoever freezes the file months later will not remember which it was.
test("a fill records its sampling: how many asks per row, and every individual ask", async () => {
  const d = mario();
  const one = await fillDecision(d, fakeJev([]));
  assert.equal(one.asksPerRow, undefined, "a filler that does not say is not made to say");
  assert.ok(one.rows.every((r) => r.asks === undefined));

  const three = majorityFiller(fakeJev([]), 3);
  const many = await fillDecision(d, three, { asksPerRow: 3 });
  assert.equal(many.asksPerRow, 3);
  const answered = many.rows.filter((r) => r.choice);
  assert.equal(answered.length, 384);
  assert.ok(answered.every((r) => Array.isArray(r.asks) && r.asks.length === 3), "each row keeps its three asks");
  assert.ok(answered.every((r) => r.asks.every((a) => typeof a.choice === "string")));

  // It survives the round trip through JSON, which is how a bundle actually carries it.
  const reloaded = JSON.parse(JSON.stringify(many));
  assert.equal(reloaded.asksPerRow, 3);
  assert.equal(freezeDecision(d, reloaded, { steps: 500 }).certificate.verification.wrong, 0);
});

// Quoting an option name is what both people and drafting models reach for first, and the
// expression language has no strings, so the quote was a bare syntax error. Measured
// 2026-09-21: it silently cost five of twenty-four decisions their candidate rules.
test("a rule may put its option names in quotes", () => {
  const charger = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));
  const d = parseDecision(charger);
  assert.equal(ruleText(d, 'swelling == 1 ? "stop" : full'), "swelling == 1 ? 0 : 2");
  assert.equal(ruleText(d, "swelling == 1 ? 'stop' : 'full'"), "swelling == 1 ? 0 : 2");
  assert.equal(ruleText(d, "swelling == 1 ? stop : full"), "swelling == 1 ? 0 : 2", "unquoted still works");
  const swollen = { temp: 3, soc: 0, cable: 1, cycles: 0, swelling: 1 };
  assert.equal(ruleFiller(d, 'swelling == 1 || temp == 3 ? "stop" : (temp == 2 ? "slow" : "full")')(swollen).choice, "stop");
});

// An anchor sheet drafted by scripts/decide.mjs ask arrives with every choice null for a person
// to fill in. A blank must not be counted as agreement, and must not be counted as a breach.
test("an unanswered anchor is skipped, not scored either way", async () => {
  const d = mario();
  const fill = await fillDecision(d, ruleFiller(d, spec.rule));
  const frozen = freezeDecision(d, fill, { steps: 500 });
  const jumps = { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 };
  const report = checkAnchors(d, frozen, { anchors: [
    { given: jumps, choice: "jump" },
    { given: jumps, choice: null, why: "" },
    { given: jumps, allow: [] },
  ] });
  assert.equal(report.checked, 1, "only the answered one is checked");
  assert.equal(report.unanswered, 2);
  assert.equal(report.broken, 0);
  assert.equal(report.anchors.length, 1);
});

// The certificate has to say whether anyone checked the policy, because the four checks it
// already reports cannot. Measured 2026-09-21: two of six decisions anchored blind were ones
// the model gets confidently wrong, and both passed row-by-row proof, Yosys, reproducibility
// and high confidence while doing it.
test("the certificate records whether a person ever checked the table, and says so when nobody has", async () => {
  const d = mario();
  const fill = await fillDecision(d, ruleFiller(d, spec.rule));
  const anchorFile = JSON.parse(readFileSync(new URL("../examples/mario-jump.anchors.json", import.meta.url), "utf8"));

  const unchecked = freezeDecision(d, fill, { steps: 400 }).certificate.decision;
  assert.equal(unchecked.policy.checkedAgainstAPerson, false);
  assert.match(unchecked.policy.warning, /nobody has checked/);
  assert.match(unchecked.notGuaranteed, /says nothing about the table/);

  const checked = freezeDecision(d, fill, { steps: 400, anchorFile }).certificate.decision;
  assert.deepEqual(checked.policy, { checkedAgainstAPerson: true, anchors: 9, held: 9, contradicted: 0, contradictedOnActedRows: 0, contradictedButReviewing: 0, unanswered: 0 });

  // A contradicted anchor is counted, not swallowed, and a blank is neither.
  const mixed = freezeDecision(d, fill, { steps: 400, anchorFile: { anchors: [
    ...anchorFile.anchors,
    { given: { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 }, choice: "no", why: "never jump" },
    { given: { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 }, choice: null },
  ] } }).certificate.decision;
  assert.deepEqual(mixed.policy, { checkedAgainstAPerson: true, anchors: 10, held: 9, contradicted: 1, contradictedOnActedRows: 1, contradictedButReviewing: 0, unanswered: 1 });
});

// The one question that is about the caller's own decision rather than about the tool: can it
// be delegated, and with the threshold where. Three outcomes, all of them reachable.
test("calibrating a decision against a person's anchors gives one of three verdicts", async () => {
  const d = mario();
  const at = (row, confidence, choice) => ({ row, choice, confidence, source: "jev" });
  const rows = [];
  for (let row = 0; row < 2 ** d.nIn; row++) {
    const codes = decodeRow(d, row);
    rows[row] = isLegal(d, codes)
      ? at(row, codes.gap_ahead <= 3 ? 0.95 : 0.45, ruleFiller(d, spec.rule)(codes).choice)
      : { row, source: "illegal" };
  }
  const fill = { codebook: d.codebookSha256, threshold: d.threshold, rows };
  const anchorFile = JSON.parse(readFileSync(new URL("../examples/mario-jump.anchors.json", import.meta.url), "utf8"));

  // Every anchor agrees with the rule that produced the fill, and the spec's own rule matches
  // it exactly - so the honest answer is to write the rule rather than freeze anything.
  const cheap = calibrateThreshold(d, fill, anchorFile, { rule: spec.rule });
  assert.equal(cheap.verdict, "write-the-rule-instead");
  // The LOWEST clean threshold wins, not the safest-looking one: the point is to decide as
  // much as possible while still agreeing with the person, and here every rung is clean.
  assert.equal(cheap.calibratedThreshold, 0.3);
  assert.ok(cheap.decides > 0.9);
  assert.equal(cheap.rule.share, 1);

  // Same fill, no rule on offer: now it is worth freezing.
  assert.equal(calibrateThreshold(d, fill, anchorFile).verdict, "delegate");

  // A person who disagrees with the confident rows cannot calibrate it at any threshold.
  const contrary = { anchors: anchorFile.anchors.map((a) => ({ ...a, choice: a.choice === "jump" ? "no" : "jump" })) };
  const bad = calibrateThreshold(d, fill, contrary, { rule: spec.rule });
  assert.equal(bad.verdict, "do-not-delegate");
  assert.equal(bad.calibratedThreshold, null);
  assert.ok(bad.sweep.every((r) => !r.clean));

  // That fill has two certainties in it, so a sweep across the rungs means something. A fill
  // from a stated rule has one, and then the seven rungs are the same table seven times -
  // callers are told so rather than drawing a table that implies a choice nobody has.
  assert.equal(cheap.confidenceValues, 2);
  const flat = { ...fill, rows: fill.rows.map((r) => (r.choice ? { ...r, confidence: 1, source: "rule" } : r)) };
  const even = calibrateThreshold(d, flat, anchorFile, { rule: spec.rule });
  assert.equal(even.confidenceValues, 1);
  assert.equal(new Set(even.sweep.map((r) => `${r.settled}/${r.anchorsAbove}/${r.held}`)).size, 1, "every rung is identical when nothing varies");

  // A refusal says which kind it is. Contradicted where it acts is a different thing from
  // agreeing everywhere it acts but on too few answers to count, and the page used to say the
  // first when it was the second.
  assert.equal(bad.why, "contradicted");
  const few = calibrateThreshold(d, fill, { anchors: anchorFile.anchors.slice(0, 3) });
  assert.equal(few.why, "too-few");
  assert.ok(few.agreesUpTo && few.agreesUpTo.held === few.agreesUpTo.anchorsAbove, "it says where it does agree");
  assert.equal(few.least, 5);
  assert.equal(cheap.why, null, "a verdict that delegates has no refusal reason");

  // Too few answers to say anything is not a pass.
  const thin = calibrateThreshold(d, fill, { anchors: anchorFile.anchors.slice(0, 3) });
  assert.equal(thin.verdict, "do-not-delegate", "fewer than five anchors above a threshold never counts as clean");
  assert.equal(thin.anchorsAnswered, 3);
});

// The anchor report has to be readable back as an anchor sheet. The exporter tried exactly
// that and crashed, because the report described each row in words but dropped the codes.
test("an anchor report can be fed back in as anchors", async () => {
  const d = mario();
  const fill = await fillDecision(d, ruleFiller(d, spec.rule));
  const frozen = freezeDecision(d, fill, { steps: 400 });
  const anchorFile = JSON.parse(readFileSync(new URL("../examples/mario-jump.anchors.json", import.meta.url), "utf8"));
  const report = checkAnchors(d, frozen, anchorFile);
  assert.ok(report.anchors.every((a) => a.given && typeof a.given === "object"));
  const again = checkAnchors(d, frozen, { anchors: report.anchors });
  assert.equal(again.checked, report.checked);
  assert.equal(again.broken, report.broken);
});

// Which situations a person is asked about. Their twenty answers are the scarcest thing in
// the pipeline, so the draw is stratified by confidence - a threshold is calibrated by what
// happens near it - and the model's answer is never carried into the sheet.
test("anchors are drawn across the confidence range, and never carry the model's answer", async () => {
  const d = mario();
  const fill = await fillDecision(d, fakeJev([]));
  const sheet = drawAnchors(d, fill, 20);
  assert.ok(sheet.anchors.length >= 5 && sheet.anchors.length <= 20);
  assert.equal(sheet.codebook, d.codebookSha256);
  assert.ok(sheet.anchors.every((a) => a.choice === null), "every one arrives unanswered");
  assert.ok(sheet.anchors.every((a) => a.given && a.situation), "codes to feed back, words to read");
  const text = JSON.stringify(sheet);
  assert.doesNotMatch(text, /"confidence"/, "the model's confidence must not travel with the question");

  // Drawn from both sides of the threshold, or a threshold cannot be calibrated from them.
  const conf = new Map(fill.rows.filter((r) => r.choice).map((r) => [r.row, r.confidence]));
  const rows = sheet.anchors.map((a) => conf.get(encodeRow(d, a.given)));
  assert.ok(rows.some((c) => c >= d.threshold) && rows.some((c) => c < d.threshold));
  assert.deepEqual(drawAnchors(d, fill, 20).anchors, sheet.anchors, "the same fill draws the same questions");
});

// Two routes to the same model. Which one a person can use decides whether they can start at
// all: direct is one signup at typesafe.ai, the Cloudflare route needs a Cloudflare account
// with Workers AI on top. The request and the reply are shaped differently, so both are pinned.
test("the decision model can be reached directly or through Cloudflare, and both shapes are handled", async () => {
  const d = mario();
  const codes = { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 };

  const seen = [];
  const directFetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return { status: 200, json: async () => ({ model: "jev-1.13.0", answers: { q: { type: "choice", choice: "jump", probabilities: { jump: 0.9, no: 0.1 }, confidence: 0.9 } }, usage: {} }) };
  };
  const direct = await jevFiller(d, { apiKey: "k", fetch: directFetch })(codes, situation(d, codes), d);
  assert.deepEqual(direct, { choice: "jump", confidence: 0.9, source: "jev" });
  assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen[0].auth, "Bearer k");
  assert.equal(seen[0].body.model, "jev-latest");
  assert.ok(seen[0].body.state && !seen[0].body.input, "direct takes state at the top level, not wrapped in input");

  const viaFetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    // Cloudflare wraps the answer twice; the filler has to see through that.
    return { status: 200, json: async () => ({ result: { result: { answers: { q: { choice: "no", confidence: 0.4 } } } } }) };
  };
  const via = await jevFiller(d, { account: "acct", token: "t", fetch: viaFetch })(codes, situation(d, codes), d);
  assert.deepEqual(via, { choice: "no", confidence: 0.4, source: "jev" });
  assert.match(seen[1].url, /api\.cloudflare\.com\/client\/v4\/accounts\/acct\/ai\/run$/);
  assert.equal(seen[1].body.model, "typesafe/jev");
  assert.ok(seen[1].body.input.state, "the Cloudflare route wraps state in input");

  // Both questions carry the codebook's own words, and neither carries a code.
  for (const s of seen) {
    const q = (s.body.input ?? s.body).questions.q;
    assert.equal(q.type, "choice");
    assert.deepEqual(Object.keys(q.criteria), ["no", "jump"]);
  }
  assert.throws(() => jevFiller(d, {}), /TYPESAFE_API_KEY|CLOUDFLARE/);
});

// A contradiction on a row that reviews is the mechanism working; one on a row the circuit
// would act on is the alarming kind. Reporting a single number for both made `calibrate` and
// `freeze` look like they disagreed on the same anchors - 16/16 against 17/20.
test("contradicted anchors are split by whether the circuit would act on that row", async () => {
  const d = mario();
  const fill = await fillDecision(d, fakeJev([]));   // sure away from the rule's edge, unsure at it
  const frozen = freezeDecision(d, fill, { steps: 400 });
  const edge = { gap_ahead: 3, enemy_ahead: 0, on_ground: 1, speed: 2 };   // reviews: right on the edge
  const clear = { gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 };  // acted on: far from it
  assert.equal(decide(frozen, edge).review, 1);
  assert.equal(decide(frozen, clear).review, 0);

  const report = checkAnchors(d, frozen, { anchors: [
    { given: edge, choice: "no", why: "contradicts a row that reviews" },
    { given: clear, choice: "no", why: "contradicts a row the circuit acts on" },
  ] });
  assert.equal(report.broken, 2);
  assert.equal(report.contradictedButReviewing, 1);
  assert.equal(report.contradictedOnActedRows, 1, "this is the one worth an alarm");
  assert.equal(frozen.certificate.decision.policy.contradictedOnActedRows, undefined, "the certificate only carries it when anchors were given");
  assert.equal(freezeDecision(d, fill, { steps: 400, anchorFile: { anchors: [{ given: edge, choice: "no" }] } })
    .certificate.decision.policy.contradictedOnActedRows, 0);
});
