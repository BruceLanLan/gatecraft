#!/usr/bin/env node
// Recursive self-improvement with a judge the improver cannot reach.
//
//   node tools/scene-loop.mjs --spec examples/comment-hold.decision.json \
//     --anchors examples/comment-hold.anchors.json --rounds 3 --sample 60 --max-calls 400
//
// The model improves ONE thing: the scene, the paragraph of context every situation is asked
// against. It never touches the codebook (the contract), the circuit, or the compiler. Two
// facts make that legitimate:
//
//   - `codebookText` does not include the scene, so a rewritten scene has the same codebook
//     hash. Rewriting how you ask is not changing what you promised. (Pinned in a test.)
//   - whether a rewrite is an improvement is decided by things the rewriter cannot see or
//     touch: anchors written by a person before any model was asked, and - where a rule can be
//     written at all - agreement with that rule on the rows the model was sure about.
//
// The accept test is deliberately not "the review list got shorter". That alone is satisfied
// by a scene that says "be decisive", which is the whole failure mode. A round is accepted
// only when the list gets shorter AND nothing a person already settled moved.
//
// What the rewriter is shown: the current scene and the situations that came back unsure, in
// the codebook's own words. NOT the answers the filler gave on them. Otherwise it could copy
// answers into prose and the fill would be laundered through the scene.
import { parseArgs } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptRound } from "./accept.mjs";
import { budget, chatFiller, majorityFiller, runOpencode, spread } from "./chat-filler.mjs";
import { decodeRow, encodeRow, isLegal, parseDecision, phrasesOf, ruleFiller, situation } from "../src/decision.mjs";
import { takeLock } from "./lock.mjs";

const { values } = parseArgs({ options: {
  spec: { type: "string" },
  anchors: { type: "string" },
  model: { type: "string", default: "opencode-go/deepseek-v4.1-flash" },
  rewriter: { type: "string", default: "opencode-go/deepseek-v4.1-flash" },
  scene0: { type: "string" },
  rounds: { type: "string", default: "3" },
  sample: { type: "string", default: "60" },
  concurrency: { type: "string", default: "5" },
  "max-calls": { type: "string", default: "400" },
  "asks-per-row": { type: "string", default: "1" },
  "on-reject": { type: "string", default: "stop" },
  json: { type: "string" },
} });
if (!values.spec) { console.error("--spec <decision.json> is required"); process.exit(2); }

takeLock();
const spec = JSON.parse(readFileSync(values.spec, "utf8"));
const d = parseDecision(spec);
const cwd = mkdtempSync(join(tmpdir(), "gatecraft-loop-"));
const spend = budget(Number(values["max-calls"]));
const rule = spec.rule ? ruleFiller(d, spec.rule) : null;

// Anchors are rows a person settled in advance. Every one of them is in the sample, or they
// cannot do their job.
const anchorFile = values.anchors ? JSON.parse(readFileSync(values.anchors, "utf8")) : { anchors: [] };
const anchors = (anchorFile.anchors ?? []).map((a) => {
  const row = encodeRow(d, a.given);
  if (!isLegal(d, decodeRow(d, row))) throw new Error(`anchor row ${row} is an illegal situation`);
  return { row, allow: new Set(a.allow ?? [a.choice]), why: a.why };
});

const legal = [];
for (let row = 0; row < 2 ** d.nIn; row++) if (isLegal(d, decodeRow(d, row))) legal.push(row);
const seeded = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const rand = seeded(20260920);
const rest = legal.filter((r) => !anchors.some((a) => a.row === r));
for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
const sample = [...new Set([...anchors.map((a) => a.row), ...rest])].slice(0, Math.max(anchors.length, Math.min(Number(values.sample), legal.length))).sort((a, b) => a - b);

const asksPerRow = Number(values["asks-per-row"]);
if (!Number.isInteger(asksPerRow) || asksPerRow < 1) { console.error("--asks-per-row must be a whole number of asks"); process.exit(2); }
if (!["stop", "retry"].includes(values["on-reject"])) { console.error("--on-reject must be stop or retry"); process.exit(2); }

async function fillWith(scene) {
  const one = chatFiller(d, { model: values.model, cwd, scene, spend });
  const filler = asksPerRow > 1 ? majorityFiller(one, asksPerRow) : one;
  const answers = new Map();
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < sample.length) {
      const row = sample[next++];
      const codes = decodeRow(d, row);
      try { answers.set(row, await filler(codes, situation(d, codes), d)); }
      catch (error) { answers.set(row, { error: String(error.message).slice(0, 90) }); }
      done += 1;
      if (done % 20 === 0) console.log(`    ${done}/${sample.length}, ${spend.used} calls`);
    }
  }));
  return answers;
}

function score(answers) {
  const ok = [...answers].filter(([, a]) => !a.error);
  const unsure = ok.filter(([, a]) => a.confidence < d.threshold);
  const sure = ok.filter(([, a]) => a.confidence >= d.threshold);
  const anchorsBroken = anchors.filter((a) => {
    const got = answers.get(a.row);
    return got && !got.error && !a.allow.has(got.choice);
  });
  const ruleAgreeSure = rule ? sure.filter(([row, a]) => a.choice === rule(decodeRow(d, row)).choice).length : null;
  return {
    answered: ok.length, failed: answers.size - ok.length,
    unsure: unsure.length, sure: sure.length,
    anchorsChecked: anchors.filter((a) => answers.get(a.row) && !answers.get(a.row).error).length,
    anchorsBroken: anchorsBroken.map((a) => ({ row: a.row, ...phrasesOf(d, decodeRow(d, a.row)), got: answers.get(a.row).choice, allowed: [...a.allow], why: a.why })),
    ruleAgreeSure, ofSure: sure.length,
    confidence: spread(ok.map(([, a]) => a.confidence)),
  };
}

// The rewriter sees the scene and the unsure situations. It does not see a single answer.
async function rewrite(scene, answers) {
  const unsure = [...answers].filter(([, a]) => !a.error && a.confidence < d.threshold).map(([row]) => row);
  if (!unsure.length) return null;
  const shown = unsure.slice(0, 40).map((row) => `- ${Object.entries(phrasesOf(d, decodeRow(d, row))).map(([f, p]) => `${f}: ${p}`).join("; ")}`);
  const prompt = [
    "Here is a paragraph of context that a reviewer is given before being asked the same question about one case at a time.",
    "", "CURRENT CONTEXT:", scene, "",
    `Reviewers read that paragraph and then answer this question: ${d.question}`,
    `Their choices are: ${d.choices.map((c) => `${c.choice} (${c.phrase})`).join("; ")}.`,
    "", "On the following cases the reviewers said they were not sure. You are NOT being told what they answered, and you must not guess.",
    ...shown,
    "",
    "Rewrite the paragraph so that someone who reads only it can answer cases like these with confidence.",
    `State the policy in general terms: what each of the ${d.choices.length} outcomes is for, and which factors move a case between them.`,
    "Do not list individual cases and their verdicts - a list of cases is not a policy.",
    "Keep it under 180 words.",
    "Reply with the rewritten paragraph and nothing else. Do not use any tools. Do not explain.",
  ].join("\n");
  spend.take();
  const out = await runOpencode(values.rewriter, prompt, { cwd });
  const body = out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n").filter((l) => !/^>\s/.test(l)).join("\n").trim();
  return body.length > 80 ? body : null;
}

console.log(`${d.name}: ${legal.length} legal situations; sample of ${sample.length} including all ${anchors.length} anchors`);
console.log(`codebook ${d.codebookSha256.slice(0, 16)} - it must not change across rounds\n`);

const rounds = [];
let scene = values.scene0 ?? d.scene;
let best = null;
const started = Date.now();
console.log(`protocol: ${asksPerRow} ask${asksPerRow === 1 ? "" : "s"} per situation, on a rejected round ${values["on-reject"] === "stop" ? "stop" : "keep the last accepted scene and try again"}\n`);
const save = () => { if (values.json) writeFileSync(values.json, `${JSON.stringify(buildReport(), null, 1)}\n`); };

for (let k = 0; k <= Number(values.rounds); k++) {
  if (spend.left < sample.length) { console.log(`stopping: ${spend.left} calls left, a round needs ${sample.length}`); break; }
  console.log(`round ${k}: filling ${sample.length} situations`);
  const answers = await fillWith(scene);
  const s = score(answers);
  const { accepted, why } = acceptRound(k === 0 ? null : best.score, s);
  console.log(`  unsure ${s.unsure}/${s.answered}, anchors broken ${s.anchorsBroken.length}/${s.anchorsChecked}${s.ruleAgreeSure === null ? "" : `, rule agreement on sure rows ${s.ruleAgreeSure}/${s.ofSure}`} -> ${why}`);
  // Every answer of every round is kept: without it a rejected round says only THAT it got
  // worse, never WHICH situations moved, and that is the only thing worth reading afterwards.
  const rows = [...answers].map(([row, a]) => ({ row, ...phrasesOf(d, decodeRow(d, row)), ...(a.error ? { error: a.error } : { choice: a.choice, confidence: a.confidence, ...(rule ? { rule: rule(decodeRow(d, row)).choice } : {}) }) }));
  rounds.push({ round: k, scene, score: s, accepted, why, codebookSha256: d.codebookSha256, rows });
  save();
  if (accepted) best = { round: k, scene, score: s, answers };
  else if (values["on-reject"] === "stop") break;
  else console.log(`  keeping the scene from round ${best.round} and asking for another rewrite`);
  if (k === Number(values.rounds)) break;
  // Always rewritten from the last ACCEPTED scene and ITS unsure rows: a rejected scene is not
  // a base to build on, and its unsure rows were produced by a scene we just threw away.
  let next = null;
  try { next = await rewrite(best.scene, best.answers); }
  catch (error) { console.log(`  no rewrite: ${error.message}`); break; }
  if (!next) { console.log("  no rewrite (nothing unsure, or the rewriter gave nothing usable)"); break; }
  scene = next;
}

function buildReport() { return {
  decision: d.name,
  codebookSha256: d.codebookSha256,
  model: values.model,
  rewriter: values.rewriter,
  note: "the filler is an ordinary chat model with self-reported confidence, not the typed decision model of jev-table.md; these numbers are not comparable to those",
  sample: sample.length,
  anchors: anchors.length,
  protocol: { asksPerRow, onReject: values["on-reject"], maxRounds: Number(values.rounds) },
  startedFrom: values.scene0 ? "a scene given on the command line" : "the scene in the spec",
  calls: spend.used,
  seconds: Math.round((Date.now() - started) / 1000),
  baseline: rounds[0] ? { unsure: rounds[0].score.unsure, of: rounds[0].score.answered } : null,
  best: best ? { round: best.round, unsure: best.score.unsure, of: best.score.answered } : null,
  drop: best && rounds[0] && rounds[0].score.unsure ? (rounds[0].score.unsure - best.score.unsure) / rounds[0].score.unsure : null,
  rounds,
}; }
const report = buildReport();
save();

console.log(`\n=== ${rounds.length} rounds, ${spend.used} calls, ${report.seconds}s ===`);
if (report.drop !== null) console.log(`unsure rows ${report.baseline.unsure} -> ${report.best.unsure} of ${report.baseline.of}: ${(100 * report.drop).toFixed(0)}% ${report.drop >= 0.3 ? "PASS (pre-registered: >= 30% with anchors intact)" : "FAIL (pre-registered: >= 30%)"}`);
for (const r of rounds) if (!r.accepted) console.log(`round ${r.round} ${r.why}`);
