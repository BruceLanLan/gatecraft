#!/usr/bin/env node
// Is this decision actually one that cannot be written as a rule?
//
//   node tools/decision-compare.mjs --spec d.json --fill a.json --fill b.json \
//     --anchors a.json --rule "<expression>" --rule "<another>" --json out.json
//
// "The best rule anyone could write disagrees with the filled table a lot" is not on its own
// evidence of anything: a table filled with noise disagrees with every rule. The two numbers
// only mean something together.
//
//   AGREEMENT  two independent fillers, asked the same situations, land on the same answer.
//              This bounds everything else. If they agree no better than the rule does, the
//              table is noise and the question cannot be answered from this run.
//   RULE       the best of the candidate rules, scored against each fill. Steelmanned on
//              purpose: the claim is that even the best rule on offer misses, so the rules are
//              taken at their most generous.
//   ROUTING    do the two fillers agree more often on rows where both were confident? That is
//              the transferable form of the confidence finding, and it needs no ground truth.
//   ANCHORS    rows a person settled before any model ran.
//
// Pre-registered before the comment-hold fills (2026-09-20): the decision counts as genuinely
// not rule-shaped if the two fillers agree on at least 80% of rows while the best rule matches
// at most 85% of either - a gap of real size in the right direction. Mario's rule matches its
// fill on 100%, which is what an upper-bound check looks like.
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeRow, encodeRow, isLegal, parseDecision, phrasesOf, ruleFiller } from "../src/decision.mjs";

const { values } = parseArgs({ options: {
  spec: { type: "string" },
  fill: { type: "string", multiple: true, default: [] },
  rule: { type: "string", multiple: true, default: [] },
  anchors: { type: "string" },
  json: { type: "string" },
} });
if (!values.spec || values.fill.length < 1) { console.error("--spec d.json --fill a.json [--fill b.json]"); process.exit(2); }

const spec = JSON.parse(readFileSync(values.spec, "utf8"));
const d = parseDecision(spec);
const fills = values.fill.map((path) => {
  const f = JSON.parse(readFileSync(path, "utf8"));
  if (f.codebook !== d.codebookSha256) throw new Error(`${path} was filled against a different codebook (${String(f.codebook).slice(0, 12)} vs ${d.codebookSha256.slice(0, 12)})`);
  const by = new Map();
  for (const r of f.rows) if (r.choice) by.set(r.row, r);
  return { path, by };
});

const candidates = [...(spec.rule ? [spec.rule] : []), ...values.rule];
const rules = candidates.map((expression) => ({ expression, says: ruleFiller(d, expression) }));

const legal = [];
for (let row = 0; row < 2 ** d.nIn; row++) if (isLegal(d, decodeRow(d, row))) legal.push(row);
const shared = legal.filter((row) => fills.every((f) => f.by.has(row)));

// AGREEMENT, and the same number split by whether both fillers were confident.
let agree = 0, bothSure = 0, bothSureAgree = 0, eitherUnsure = 0, eitherUnsureAgree = 0;
const disagreements = [];
if (fills.length > 1) {
  for (const row of shared) {
    const answers = fills.map((f) => f.by.get(row));
    const same = answers.every((a) => a.choice === answers[0].choice);
    if (same) agree += 1;
    else disagreements.push({ row, ...phrasesOf(d, decodeRow(d, row)), answers: answers.map((a, i) => ({ fill: values.fill[i], choice: a.choice, confidence: a.confidence })) });
    const sure = answers.every((a) => (a.confidence ?? 1) >= d.threshold);
    if (sure) { bothSure += 1; if (same) bothSureAgree += 1; }
    else { eitherUnsure += 1; if (same) eitherUnsureAgree += 1; }
  }
}

// RULE, scored against each fill, best rule wins.
const scored = rules.map((r) => ({
  expression: r.expression,
  against: fills.map((f) => {
    const rows = [...f.by.keys()];
    const hit = rows.filter((row) => f.by.get(row).choice === r.says(decodeRow(d, row)).choice).length;
    return { fill: f.path, matched: hit, of: rows.length, share: rows.length ? hit / rows.length : 0 };
  }),
}));
const bestShare = Math.max(0, ...scored.flatMap((r) => r.against.map((a) => a.share)));

// ANCHORS: what each fill did on the rows a person settled in advance.
const anchorFile = values.anchors ? JSON.parse(readFileSync(values.anchors, "utf8")) : null;
const anchors = (anchorFile?.anchors ?? []).map((a) => ({ row: encodeRow(d, a.given), allow: new Set(a.allow ?? [a.choice]), why: a.why }));
const anchorScore = fills.map((f) => {
  const checked = anchors.filter((a) => f.by.has(a.row));
  const broken = checked.filter((a) => !a.allow.has(f.by.get(a.row).choice));
  return { fill: f.path, checked: checked.length, broken: broken.map((a) => ({ row: a.row, ...phrasesOf(d, decodeRow(d, a.row)), got: f.by.get(a.row).choice, allowed: [...a.allow], why: a.why })) };
});
const anchorRuleScore = rules.map((r) => ({
  expression: r.expression,
  broken: anchors.filter((a) => !a.allow.has(r.says(decodeRow(d, a.row)).choice)).length,
  of: anchors.length,
}));

// Where two fillers disagree, are they one step apart or opposite ends? When the choices form
// a ladder - and here they do, keep < fold < remove - that distinction separates "two
// different strictnesses" from "noise". It is only meaningful when the declaration order IS a
// ladder, which the decision file has to say; nothing checks it.
const rung = Object.fromEntries(d.choices.map((c, i) => [c.choice, i]));
const steps = {};
for (const dis of disagreements) {
  const at = dis.answers.map((a) => rung[a.choice]);
  const gap = Math.max(...at) - Math.min(...at);
  steps[gap] = (steps[gap] ?? 0) + 1;
}

const report = {
  decision: d.name,
  codebookSha256: d.codebookSha256,
  fills: values.fill,
  legal: legal.length,
  compared: shared.length,
  agreement: fills.length > 1 ? {
    same: agree, of: shared.length, share: shared.length ? agree / shared.length : null,
    bothSure: { same: bothSureAgree, of: bothSure, share: bothSure ? bothSureAgree / bothSure : null },
    eitherUnsure: { same: eitherUnsureAgree, of: eitherUnsure, share: eitherUnsure ? eitherUnsureAgree / eitherUnsure : null },
  } : null,
  ladder: { order: d.choices.map((c) => c.choice), stepsApart: steps },
  rules: scored,
  bestRuleShare: bestShare,
  anchors: { fills: anchorScore, rules: anchorRuleScore, total: anchors.length },
  disagreements: disagreements.slice(0, 60),
};
if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 1)}\n`);

const pc = (x) => (x === null || x === undefined ? "-" : `${(100 * x).toFixed(0)}%`);
console.log(`${d.name}: ${legal.length} legal situations, ${shared.length} answered by every fill`);
if (report.agreement) {
  const a = report.agreement;
  console.log(`AGREEMENT  ${a.same}/${a.of} = ${pc(a.share)} between fillers`);
  console.log(`           both sure ${a.bothSure.same}/${a.bothSure.of} = ${pc(a.bothSure.share)}   either unsure ${a.eitherUnsure.same}/${a.eitherUnsure.of} = ${pc(a.eitherUnsure.share)}`);
  console.log(`ROUTING    ${a.bothSure.share !== null && a.eitherUnsure.share !== null ? (a.bothSure.share > a.eitherUnsure.share ? "PASS - confident rows agree more" : "FAIL - confidence does not pick out the rows they agree on") : "UNMEASURABLE - every row fell on one side"}`);
}
if (Object.keys(steps).length) console.log(`LADDER     ${d.choices.map((c) => c.choice).join(" < ")}: ${Object.entries(steps).sort().map(([gap, n]) => `${n} disagreements ${gap} step${gap === "1" ? "" : "s"} apart`).join(", ")}`);
for (const r of scored) console.log(`RULE       ${r.against.map((a) => `${a.matched}/${a.of} = ${pc(a.share)}`).join("   ")}   ${r.expression.slice(0, 70)}`);
console.log(`BEST RULE  ${pc(bestShare)}`);
if (report.agreement) {
  const rule_less = report.agreement.share >= 0.8 && bestShare <= 0.85;
  console.log(`VERDICT    ${rule_less ? "not rule-shaped: the fillers agree with each other well above what any rule captures" : report.agreement.share < 0.8 ? "unanswerable from this run: the fillers do not agree with each other enough to conclude anything" : "rule-shaped after all: a written rule captures the table"}`);
}
for (const s of anchorScore) console.log(`ANCHORS    ${s.checked - s.broken.length}/${s.checked} held  ${s.fill}`);
for (const s of anchorRuleScore) console.log(`           ${s.of - s.broken}/${s.of} held by rule  ${s.expression.slice(0, 60)}`);
