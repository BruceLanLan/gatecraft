#!/usr/bin/env node
// Before trusting a chat model's confidence, measure whether it says anything at all.
//
//   node tools/calibrate.mjs --spec examples/mario-jump.decision.json --sample 96 \
//     --model opencode-go/deepseek-v4.1-flash --repeat 30 --max-calls 200 --json out.json
//
// Two orthogonal knobs, easy to confuse, so they are named apart and both land in the report:
//   --asks-per-row N  each answer is itself the majority of N asks (1 = one ask, the default)
//   --repeat M        M of the sampled rows are answered a SECOND time, to measure stability
//
// Everything downstream - the review list, the accept test of the scene-rewrite loop - is a
// function of the confidence number. Jev returns a calibrated probability; a chat model
// returns a number it wrote itself, and self-reported confidence usually collapses onto two
// or three values. If it does, the threshold is inert, review count stops meaning anything,
// and a loop that optimises review count is optimising nothing.
//
// Pre-registered before the first call (2026-09-20):
//   SPREAD   the confidence carries information if fewer than 90% of answers land on one value.
//   ROUTING  it routes if high-confidence rows agree with the stated rule strictly more often
//            than low-confidence rows do.
//   REPEAT   asking the same situation twice gives the same choice at least 90% of the time;
//            below that, every other number in the run is inside the noise.
//
// Pre-registered before the first --asks-per-row 3 run (2026-09-20, after single asks came back
// at 14/20): majority-of-3 is worth its threefold cost only if, among the rows it marks
// ACTIONABLE (confidence >= threshold after the majority penalty), at least 90% give the same
// choice when a second independent majority-of-3 is taken. Reproducing better overall is not
// the test - averaging three samples does that mechanically. The test is about the rows the
// bundle tells a person not to look at. Reported next to it, and needed to read it honestly:
// how many rows survive as actionable at all. A bundle where nothing is actionable is honest
// and is also not a deliverable.
// The rule is only available where one can be written (Mario). Without it, ROUTING is skipped
// and the probe reports SPREAD and REPEAT alone. CAREFUL: on a decision whose whole point is
// that no rule captures it, the spec's "rule" is somebody's best effort, not ground truth -
// ROUTING then says only "the confident rows look more like that rule", which is a weak aside,
// never an accuracy.
import { parseArgs } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { budget, chatFiller, majorityFiller, spread } from "./chat-filler.mjs";
import { decodeRow, isLegal, jevFiller, parseDecision, phrasesOf, ruleFiller, situation } from "../src/decision.mjs";
import { homedir } from "node:os";
import { takeLock } from "./lock.mjs";

const { values } = parseArgs({ options: {
  spec: { type: "string" },
  model: { type: "string", default: "opencode-go/deepseek-v4.1-flash" },
  sample: { type: "string", default: "96" },
  repeat: { type: "string", default: "30" },
  "asks-per-row": { type: "string", default: "1" },
  with: { type: "string", default: "chat" },
  concurrency: { type: "string", default: "5" },
  "max-calls": { type: "string", default: "200" },
  json: { type: "string" },
} });
if (!values.spec) { console.error("--spec <decision.json> is required"); process.exit(2); }

takeLock();
const spec = JSON.parse(readFileSync(values.spec, "utf8"));
const d = parseDecision(spec);
const cwd = mkdtempSync(join(tmpdir(), "gatecraft-probe-"));

// A fixed, stated sample: the same rows every time this is re-run, so two runs compare.
const seeded = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const legal = [];
for (let row = 0; row < 2 ** d.nIn; row++) if (isLegal(d, decodeRow(d, row))) legal.push(row);
const rand = seeded(20260920);
const shuffled = legal.slice();
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const sample = shuffled.slice(0, Math.min(Number(values.sample), legal.length)).sort((a, b) => a - b);

const rule = spec.rule ? ruleFiller(d, spec.rule) : null;
const ruleSays = (codes) => rule(codes).choice;

const spend = budget(Number(values["max-calls"]));
const asksPerRow = Number(values["asks-per-row"]);
if (!Number.isInteger(asksPerRow) || asksPerRow < 1) { console.error("--asks-per-row must be a whole number of asks"); process.exit(2); }
// The probe has to work on the calibrated instrument too - "its confidence was calibrated
// once" is not the same claim as "the rows it marks actionable come back the same", and the
// second one had never been measured for it. NOTE: --max-calls caps the chat route only;
// the typed model is asked once per row per pass and is about $0.00005 a call.
const credential = (name) => { try { return readFileSync(join(homedir(), ".config", "gatecraft", name), "utf8").trim() || null; } catch { return null; } };
const oneAsk = values.with === "jev"
  ? jevFiller(d, { account: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || credential("cloudflare.account"), token: process.env.CLOUDFLARE_API_TOKEN?.trim() || credential("cloudflare.token") })
  : chatFiller(d, { model: values.model, cwd, spend });
const filler = asksPerRow > 1 ? majorityFiller(oneAsk, asksPerRow) : oneAsk;
const started = Date.now();
const answers = new Map();
let done = 0;

async function askAll(rows, into) {
  let next = 0;
  await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const codes = decodeRow(d, row);
      try {
        into.set(row, await filler(codes, situation(d, codes), d));
      } catch (error) {
        into.set(row, { error: String(error.message).slice(0, 100) });
      }
      done += 1;
      if (done % 16 === 0) console.log(`  ${done} asked, ${spend.used} calls, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }));
}

console.log(`${d.name}: ${legal.length} legal situations, asking ${sample.length} of them through ${values.with === "jev" ? "typesafe/jev" : values.model}`);
await askAll(sample, answers);

const second = new Map();
const repeatRows = sample.slice(0, Math.min(Number(values.repeat), sample.length));
if (repeatRows.length && spend.left > repeatRows.length) {
  console.log(`asking ${repeatRows.length} of them a second time`);
  await askAll(repeatRows, second);
}

const ok = [...answers].filter(([, a]) => !a.error);
const confidences = ok.map(([, a]) => a.confidence);
const sp = spread(confidences);
const high = ok.filter(([, a]) => a.confidence >= d.threshold);
const low = ok.filter(([, a]) => a.confidence < d.threshold);
const agree = (list) => (rule ? list.filter(([row, a]) => a.choice === ruleSays(decodeRow(d, row))).length : null);
const repeated = [...second].filter(([row, a]) => !a.error && answers.get(row) && !answers.get(row).error);
const same = repeated.filter(([row, a]) => a.choice === answers.get(row).choice).length;

const report = {
  decision: d.name,
  codebookSha256: d.codebookSha256,
  model: values.with === "jev" ? "typesafe/jev" : values.model,
  filler: values.with,
  asksPerRow,
  rowsAskedTwice: Number(values.repeat),
  note: "a chat model's self-reported confidence; not the same instrument as the typed decision model in jev-table.md, and not comparable to those numbers",
  asked: sample.length,
  answered: ok.length,
  failed: sample.length - ok.length,
  calls: spend.used,
  seconds: Math.round((Date.now() - started) / 1000),
  threshold: d.threshold,
  spread: sp,
  routing: rule ? {
    agreeAll: agree(ok), ofAll: ok.length,
    agreeHigh: agree(high), ofHigh: high.length,
    agreeLow: agree(low), ofLow: low.length,
  } : null,
  repeat: repeated.length ? { asked: repeated.length, sameChoice: same, share: same / repeated.length } : null,
  actionable: (() => {
    const both = repeated.filter(([row]) => answers.get(row).confidence >= d.threshold);
    const held = both.filter(([row, a]) => a.choice === answers.get(row).choice).length;
    return { ofAnswered: ok.length, marked: high.length, share: ok.length ? high.length / ok.length : null, askedTwice: both.length, reproduced: held, reproducedShare: both.length ? held / both.length : null };
  })(),
  // Every individual ask is kept, not just the majority: how a majority should be scored is a
  // design choice (this one penalises by the winner's share), and keeping the asks means an
  // alternative scoring can be tried on the saved file instead of paying for the run again.
  rows: ok.map(([row, a]) => ({ row, ...phrasesOf(d, decodeRow(d, row)), choice: a.choice, confidence: a.confidence, ...(a.asks ? { asks: a.asks } : {}), ...(rule ? { rule: ruleSays(decodeRow(d, row)) } : {}), ...(second.get(row) && !second.get(row).error ? { again: second.get(row).choice, againConfidence: second.get(row).confidence } : {}) })),
};
if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 1)}\n`);

const pct = (a, b) => (b ? `${a}/${b} = ${(100 * a / b).toFixed(0)}%` : "-");
console.log(`\n=== ${report.answered}/${report.asked} answered with ${asksPerRow} ask${asksPerRow === 1 ? "" : "s"} each, ${report.calls} calls, ${report.seconds}s ===`);
console.log(`SPREAD  ${sp.distinct} distinct values, ${(100 * sp.modalShare).toFixed(0)}% on ${sp.modal}  ${sp.modalShare < 0.9 ? "PASS" : "FAIL - confidence carries no information"}`);
console.log(`        ${sp.top.map((t) => `${t.value}x${t.count}`).join("  ")}`);
if (report.routing) {
  const r = report.routing;
  const rateHigh = r.ofHigh ? r.agreeHigh / r.ofHigh : null;
  const rateLow = r.ofLow ? r.agreeLow / r.ofLow : null;
  const verdict = r.agreeAll === r.ofAll ? "UNMEASURABLE - the model made no mistakes here, so there was nothing for confidence to route"
    : rateHigh === null || rateLow === null ? "UNMEASURABLE - every answer fell on one side of the threshold"
      : rateHigh > rateLow ? "PASS" : "FAIL - high confidence is no better than low";
  console.log(`ROUTING all ${pct(r.agreeAll, r.ofAll)}  high ${pct(r.agreeHigh, r.ofHigh)}  low ${pct(r.agreeLow, r.ofLow)}  ${verdict}`);
}
if (report.repeat) console.log(`REPEAT  ${pct(report.repeat.sameChoice, report.repeat.asked)} same choice  ${report.repeat.share >= 0.9 ? "PASS" : "FAIL - the model is not stable enough to measure through"}`);
const act = report.actionable;
if (act.askedTwice) {
  console.log(`ACTION  ${pct(act.marked, act.ofAnswered)} of answered rows are marked actionable (review = 0)`);
  console.log(`        of those asked twice, ${pct(act.reproduced, act.askedTwice)} give the same choice again  ${act.reproducedShare >= 0.9 ? "PASS (pre-registered: >= 90%)" : "FAIL (pre-registered: >= 90%) - rows this bundle tells a person to trust do not reproduce"}`);
}
