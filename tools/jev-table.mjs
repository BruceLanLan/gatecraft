#!/usr/bin/env node
// Can a typed decision model fill a decision's whole table, one situation at a time?
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node tools/jev-table.mjs --json out.json
//
// The idea (the person's, 2026-09-20): a language model only names the decision - what it
// looks at and what it can do - and never writes a program. Every situation the decision can
// be in is then put to a typed decision model as a plain question, and its answers ARE the
// truth table. The compiler freezes that table into a circuit proven on every row. Nothing
// in this path asks a model to write code that must agree with its own examples, which is
// where every failure measured so far happened.
//
// The decision here is Mario's "jump now?" over 9 bits of observation, 512 situations:
//   gap_ahead   3 bits  0 = no gap in view, else tiles until the gap
//   enemy_ahead 3 bits  0 = no enemy in view, else tiles until it
//   on_ground   1 bit
//   speed       2 bits  0 stopped, 1 walking, 2 running, 3 sprinting
//
// Pre-registered before the run: it works if at least 90% of rows come back with confidence
// >= 0.7, every in-air row says "no" (you cannot jump in mid-air), and the ten obvious
// situations below are answered the obvious way. Inconsistency between neighbouring rows is
// counted and reported, not judged. Cost is measured from the usage the provider reports.
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { compileTable } from "../src/compile.mjs";
import { takeLock } from "./lock.mjs";

const FIELDS = [["gap_ahead", 3], ["enemy_ahead", 3], ["on_ground", 1], ["speed", 2]];
const N_IN = FIELDS.reduce((s, [, w]) => s + w, 0);
const SPEED = ["stopped", "walking", "running", "sprinting"];

const decode = (row) => {
  const v = {};
  let shift = 0;
  for (const [name, width] of FIELDS) { v[name] = (row >>> shift) & (2 ** width - 1); shift += width; }
  return v;
};
const encode = (v) => FIELDS.reduce(([acc, shift], [name, width]) => [acc | (v[name] << shift), shift + width], [0, 0])[0];

// The situation, said the way a person would say it. The model knows nothing about bits.
// Two ways to describe the scene. VAGUE leaves the physics unsaid, as a first prompt would;
// RULED states how far a jump carries, the way a language model that read the requirement
// would have to. The second run measures whether low confidence was missing information.
const SCENES = {
  vague: "A side-scrolling platform game. Mario runs to the right. Falling into a gap or touching an enemy loses a life. Jumping from the ground clears gaps and enemies; jumping too early lands short.",
  ruled: "A side-scrolling platform game. Mario runs to the right. Falling into a gap or touching an enemy loses a life. A jump from the ground carries Mario forward a fixed distance: 1 tile when stopped, 2 tiles walking, 3 tiles running, 4 tiles sprinting. He should press jump exactly when a gap or an enemy lies ahead within that distance, so the jump carries him past it; jumping when nothing is within that distance lands him short or wastes the jump. He cannot jump in mid-air.",
};
// The same rule as code, to measure how faithfully the model applies a stated rule.
const REACH = [1, 2, 3, 4];
const ruleSays = (v) => (v.on_ground && ((v.gap_ahead > 0 && v.gap_ahead <= REACH[v.speed]) || (v.enemy_ahead > 0 && v.enemy_ahead <= REACH[v.speed])) ? "jump" : "no");
const stateOf = (v) => ({
  scene: SCENES[values.scene],
  gap_ahead: v.gap_ahead === 0 ? "no gap in view" : `a gap ${v.gap_ahead} tile${v.gap_ahead === 1 ? "" : "s"} ahead`,
  enemy_ahead: v.enemy_ahead === 0 ? "no enemy in view" : `an enemy ${v.enemy_ahead} tile${v.enemy_ahead === 1 ? "" : "s"} ahead`,
  mario: v.on_ground ? "standing or running on the ground" : "in mid-air",
  speed: SPEED[v.speed],
});
const QUESTION = { instructions: "Should Mario press jump at this exact moment?", criteria: { jump: "press jump now", no: "do not jump now" } };

const OBVIOUS = [
  [{ gap_ahead: 1, enemy_ahead: 0, on_ground: 1, speed: 2 }, "jump", "gap right ahead, running"],
  [{ gap_ahead: 2, enemy_ahead: 0, on_ground: 1, speed: 3 }, "jump", "gap two tiles ahead, sprinting"],
  [{ gap_ahead: 0, enemy_ahead: 1, on_ground: 1, speed: 1 }, "jump", "enemy right ahead"],
  [{ gap_ahead: 0, enemy_ahead: 0, on_ground: 1, speed: 1 }, "no", "nothing in view"],
  [{ gap_ahead: 0, enemy_ahead: 0, on_ground: 1, speed: 0 }, "no", "nothing in view, stopped"],
  [{ gap_ahead: 7, enemy_ahead: 0, on_ground: 1, speed: 1 }, "no", "gap far away"],
  [{ gap_ahead: 0, enemy_ahead: 7, on_ground: 1, speed: 1 }, "no", "enemy far away"],
  [{ gap_ahead: 1, enemy_ahead: 0, on_ground: 0, speed: 2 }, "no", "already in mid-air"],
  [{ gap_ahead: 0, enemy_ahead: 1, on_ground: 0, speed: 1 }, "no", "in mid-air over an enemy"],
  [{ gap_ahead: 1, enemy_ahead: 1, on_ground: 1, speed: 2 }, "jump", "gap and enemy both right ahead"],
];

async function ask(state, via) {
  for (let go = 1; go <= 4; go++) {
    try {
      const response = await fetch(via.url, {
        method: "POST",
        headers: { authorization: `Bearer ${via.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "typesafe/jev", input: { state, questions: { q: { type: "choice", ...QUESTION } } } }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json();
      if (response.status === 429 || response.status >= 500) throw new Error(`${response.status}`);
      const answer = (body.result?.result ?? body.result ?? body).answers?.q;
      if (!answer) throw new Error(`no answers.q: ${JSON.stringify(body).slice(0, 160)}`);
      return { choice: answer.choice, p: answer.probabilities?.jump ?? null, confidence: answer.confidence ?? null, usage: body.result?.usage ?? body.result?.result?.usage ?? null };
    } catch (error) {
      if (go === 4) throw error;
      await new Promise((r) => setTimeout(r, 1500 * go));
    }
  }
}

takeLock();
const { values } = parseArgs({ options: { json: { type: "string" }, concurrency: { type: "string", default: "8" }, steps: { type: "string" }, scene: { type: "string", default: "vague" } } });
if (!SCENES[values.scene]) { console.error("--scene vague|ruled"); process.exit(2); }
const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!account || !token) { console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed"); process.exit(2); }
const via = { url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`, token };

const rows = new Array(2 ** N_IN);
let next = 0;
let done = 0;
const started = Date.now();
const save = () => { if (values.json) writeFileSync(values.json, `${JSON.stringify({ fields: FIELDS, rows: rows.filter(Boolean) }, null, 0)}\n`); };
await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
  while (next < rows.length) {
    const row = next++;
    const v = decode(row);
    try {
      rows[row] = { row, ...v, ...(await ask(stateOf(v), via)) };
    } catch (error) {
      rows[row] = { row, ...v, error: String(error.message).slice(0, 80) };
    }
    done += 1;
    if (done % 64 === 0) { save(); console.log(`${done}/${rows.length}  ${((Date.now() - started) / 1000).toFixed(0)}s`); }
  }
}));
save();

const answered = rows.filter((r) => r.choice);
const seconds = (Date.now() - started) / 1000;
const inputTokens = answered.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0);
const outputTokens = answered.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0);
console.log(`\n=== ${answered.length}/${rows.length} situations answered in ${seconds.toFixed(0)}s; ${rows.length - answered.length} failed ===`);
console.log(`tokens: ${inputTokens} in + ${outputTokens} out; at the listed $0.042/M input that is about $${(inputTokens / 1e6 * 0.042).toFixed(4)} (output priced separately, if at all)`);

const jumps = answered.filter((r) => r.choice === "jump").length;
console.log(`jump ${jumps}, no ${answered.length - jumps}`);
const conf = answered.map((r) => r.confidence ?? 0);
const bins = [0, 0.5, 0.7, 0.9, 1.01];
console.log("confidence:", bins.slice(0, -1).map((lo, i) => `${lo}-${bins[i + 1] > 1 ? 1 : bins[i + 1]}: ${conf.filter((c) => c >= lo && c < bins[i + 1]).length}`).join("  "));
const sure = conf.filter((c) => c >= 0.7).length;
console.log(`rows with confidence >= 0.7: ${sure} = ${(sure / answered.length * 100).toFixed(0)}%  (pre-registered: >= 90%)`);

const air = answered.filter((r) => r.on_ground === 0);
const airJumps = air.filter((r) => r.choice === "jump").length;
console.log(`in-air rows saying jump: ${airJumps}/${air.length}  (pre-registered: 0)`);

console.log("\nobvious situations:");
let obviousRight = 0;
for (const [v, want, why] of OBVIOUS) {
  const r = rows[encode(v)];
  const ok = r?.choice === want;
  obviousRight += ok ? 1 : 0;
  console.log(`  ${ok ? "✓" : "✗"} ${why.padEnd(38)} wanted ${want.padEnd(4)} got ${String(r?.choice).padEnd(4)} p(jump)=${r?.p ?? "?"} conf=${r?.confidence ?? "?"}`);
}
console.log(`  ${obviousRight}/${OBVIOUS.length} (pre-registered: 10/10)`);

// Neighbours that differ in one field's value by one step and answer differently. Some of
// these are real edges (jump at 2 tiles, not at 3); many in a row are noise.
let edges = 0, pairs = 0;
for (const r of answered) {
  for (const [name, width] of FIELDS) {
    if (r[name] + 1 >= 2 ** width) continue;
    const s = rows[encode({ ...r, [name]: r[name] + 1 })];
    if (!s?.choice) continue;
    pairs += 1;
    if (s.choice !== r.choice) edges += 1;
  }
}
console.log(`\nneighbouring situations (one step apart) that answer differently: ${edges}/${pairs}`);
const agree = answered.filter((r) => r.choice === ruleSays(r)).length;
console.log(`agreement with the stated rule written as code: ${agree}/${answered.length} = ${(agree / answered.length * 100).toFixed(0)}%${values.scene === "vague" ? " (the vague scene never stated the rule; this is how close a guess lands)" : " (pre-registered for the ruled scene: >= 95%)"}`);
const disagreements = answered.filter((r) => r.choice !== ruleSays(r)).slice(0, 8);
for (const r of disagreements) console.log(`  rule ${ruleSays(r).padEnd(4)} model ${r.choice.padEnd(4)} p=${r.p} conf=${r.confidence}  gap ${r.gap_ahead} enemy ${r.enemy_ahead} ground ${r.on_ground} speed ${SPEED[r.speed]}`);

// Freeze it: the table is the truth table, jump = 1.
const ys = Uint32Array.from(rows, (r) => (r?.choice === "jump" ? 1 : 0));
const t = Date.now();
const { certificate } = compileTable({ nIn: N_IN, nState: 0, nOut: 1, ys }, { steps: values.steps ? Number(values.steps) : undefined });
console.log(`\ncompiled: ${certificate.circuit.nand} NAND, depth ${certificate.circuit.depth}, ${certificate.verification.rowsChecked}/${certificate.verification.rowsChecked} rows exact, ${((Date.now() - t) / 1000).toFixed(1)}s`);
if (values.json) writeFileSync(values.json, `${JSON.stringify({ fields: FIELDS, scene: values.scene, question: QUESTION, seconds, agree, inputTokens, outputTokens, obviousRight, edges, pairs, sure, airJumps, circuit: certificate.circuit, rows: rows.filter(Boolean) }, null, 0)}\n`);
