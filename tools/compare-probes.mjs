#!/usr/bin/env node
// Two independent passes of tools/calibrate.mjs over the same rows: does an answer the bundle
// would mark ACTIONABLE come back the same when the whole measurement is repeated?
//
//   node tools/compare-probes.mjs a.json b.json
//
// This is the test that can fail. "Averaging three samples reproduces better than one" is
// arithmetic; the question that decides whether a bundle is worth delivering is narrower:
// among the rows marked review = 0 - the ones a person is told not to look at - how many give
// the same choice when the same procedure is run again? Pre-registered bar: 90%.
import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2).map((p) => ({ path: p, ...JSON.parse(readFileSync(p, "utf8")) }));
if (!a || !b) { console.error("give two calibrate --json reports"); process.exit(2); }
if (a.codebookSha256 !== b.codebookSha256) throw new Error("the two passes are against different codebooks");

const t = a.threshold;
const byRow = new Map(b.rows.map((r) => [r.row, r]));
const both = a.rows.filter((r) => byRow.has(r.row));
const same = (r) => r.choice === byRow.get(r.row).choice;

const view = (label, rows) => {
  const held = rows.filter(same).length;
  return { label, of: rows.length, same: held, share: rows.length ? held / rows.length : null };
};
const all = view("every row compared", both);
const actionable = view(`marked actionable in pass 1 (confidence >= ${t})`, both.filter((r) => r.confidence >= t));
const reviewing = view("marked for review in pass 1", both.filter((r) => r.confidence < t));
const sureBoth = view("marked actionable in BOTH passes", both.filter((r) => r.confidence >= t && byRow.get(r.row).confidence >= t));

const pc = (x) => (x === null ? "-" : `${(100 * x).toFixed(0)}%`);
console.log(`${a.decision}: ${a.model}, ${a.asksPerRow ?? 1} ask(s) per row, ${both.length} rows in both passes`);
for (const v of [all, actionable, reviewing, sureBoth]) console.log(`  ${v.same}/${v.of} = ${pc(v.share)}  ${v.label}`);
console.log(`  actionable share: pass 1 ${both.filter((r) => r.confidence >= t).length}/${both.length}, pass 2 ${both.filter((r) => byRow.get(r.row).confidence >= t).length}/${both.length}`);
console.log(`VERDICT  ${actionable.of < 10 ? `UNMEASURABLE - only ${actionable.of} actionable rows to test` : actionable.share >= 0.9 ? "PASS (pre-registered: >= 90% of actionable rows reproduce)" : "FAIL (pre-registered: >= 90%) - rows this bundle marks actionable do not survive a repeat"}`);
for (const r of both.filter((r) => r.confidence >= t && !same(r))) {
  console.log(`  flipped: ${Object.entries(r).filter(([k]) => !["row", "choice", "confidence", "rule", "again", "againConfidence", "asks"].includes(k)).map(([, v]) => String(v).slice(0, 22)).join(" | ")} => ${r.choice}@${r.confidence} then ${byRow.get(r.row).choice}@${byRow.get(r.row).confidence}`);
}
