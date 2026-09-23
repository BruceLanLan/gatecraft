#!/usr/bin/env node
// Turning a one-line description of a real recurring decision into a codebook, and then into
// candidate rules - both drafted by a chat model, both judged by code.
//
//   node tools/band-draft.mjs --in raw.txt --out out/band20
//
// Why a model drafts them: if I write twenty codebooks myself, the sample is my imagination of
// what a decision looks like, and that is the failure the 300-wishes study was designed to
// avoid. Drafting is generative work, which is what a chat model is for; judging is not, so
// nothing here trusts it:
//
//   - `parseDecision` decides whether the shape is legal at all.
//   - every observed field must fit in 3 bits (at most 8 named buckets). A decision that needs
//     more is not one of ours and is recorded as not fitting, not quietly widened.
//   - a draft that fails twice is recorded as NOT FITTING. Those failures are part of the
//     answer to "what fraction of real decisions fit a codebook", not noise to be retried away.
//   - candidate rules are checked by `ruleFiller`, and they are drafted from the codebook ALONE,
//     before a single situation has been put to any model. That ordering is the measurement.
//
// What this cannot check, and a person still has to: whether the buckets are honest - that the
// caller really could compute them without reading text, knowing who someone is, going to the
// network, or looking at a clock. The tool prints every field so that stays reviewable.
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budget, runOpencode } from "./chat-filler.mjs";
import { parseDecision, ruleFiller } from "../src/decision.mjs";
import { takeLock } from "./lock.mjs";
import { codebookPrompt } from "../src/draft.mjs";

const { values } = parseArgs({ options: {
  in: { type: "string" }, out: { type: "string" },
  model: { type: "string", default: "opencode-go/glm-5.3" },
  "rules-model": { type: "string", default: "opencode-go/deepseek-v4.1-flash" },
  "max-calls": { type: "string", default: "120" },
  limit: { type: "string", default: "20" },
  concurrency: { type: "string", default: "4" },
} });
if (!values.in || !values.out) { console.error("--in raw.txt --out DIR"); process.exit(2); }

takeLock();
const cwd = mkdtempSync(join(tmpdir(), "gatecraft-band-"));
const spend = budget(Number(values["max-calls"]));
mkdirSync(values.out, { recursive: true });

const lines = readFileSync(values.in, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.includes("|")).slice(0, Number(values.limit));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 3).join("-").slice(0, 40) || "decision";

const json = (text) => {
  const clean = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < clean.length; j++) {
      if (clean[j] === "{") depth += 1;
      else if (clean[j] === "}" && --depth === 0) {
        try { return JSON.parse(clean.slice(i, j + 1)); } catch { break; }
      }
    }
  }
  return null;
};

const CODEBOOK_PROMPT = codebookPrompt;   // shared with scripts/decide.mjs draft

const RULES_PROMPT = (d) => `A decision is made over and over by a program. It looks at these, and each one is already one of a few numbered buckets:

${d.fields.map((f) => `${f.field}: ${[...f.values].sort((a, b) => a[0] - b[0]).map(([code, phrase]) => `${code} = ${phrase}`).join("; ")}`).join("\n")}

It must choose one of: ${d.choices.map((c) => `${c.choice} (${c.phrase})`).join(", ")}

The question asked about every case is: ${d.question}

Write the 4 best rules you can that decide it from those fields alone. A rule is ONE expression in C/JavaScript syntax over the field names, whose value is one of the option names, using the bucket numbers above. Allowed: == != < <= > >= && || ! and ?: - nothing else, no variables, no functions.

Shape: cond ? option_a : (cond2 ? option_b : option_c)

Make them genuinely different and as good as you can: this tests whether a short rule can capture this decision at all, so weak rules waste it.

Reply with a JSON array of exactly 4 strings. Nothing else.`;

// Drafting one decision does not depend on drafting another, and the drafting model takes the
// better part of a minute per call, so these run several at a time. The read-modify-write of
// rules.json below is synchronous with no await inside it, which is what makes it safe here.
const ok = [], failed = [];
let next = 0;
await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
 while (next < lines.length) {
  const line = lines[next++];
  const name = slug(line.split("|")[0]);
  const already = join(values.out, `${name}.decision.json`);
  let spec = null, why = "";
  // Resume: a codebook already on disk is not drafted again. Restarting this tool after a fix
  // should cost only the part that was broken.
  if (existsSync(already)) { try { spec = JSON.parse(readFileSync(already, "utf8")); parseDecision(spec); } catch { spec = null; } }
  for (let go = 0; go < 2 && !spec; go++) {
    if (spend.left < 2) break;
    spend.take();
    try {
      const draft = json(await runOpencode(values.model, CODEBOOK_PROMPT(line) + (why ? `\n\nYour previous attempt was rejected: ${why}\nFix exactly that.` : ""), { cwd }));
      if (!draft) throw new Error("no JSON object in the reply");
      draft.name = name;
      const d = parseDecision(draft);
      const wide = d.fields.find((f) => f.width > 3);
      if (wide) throw new Error(`field "${wide.field}" is ${wide.width} bits; a decision's observation may not have more than 8 buckets`);
      spec = draft;
    } catch (error) { why = String(error.message).slice(0, 200); }
  }
  if (!spec) { failed.push({ line, why }); console.log(`NOT FITTING  ${name}: ${why}`); continue; }

  const d = parseDecision(spec);
  let rules = null;
  for (let go = 0; go < 2 && !rules; go++) {
    if (spend.left < 1) break;
    spend.take();
    try {
      const text = (await runOpencode(values["rules-model"], RULES_PROMPT(d), { cwd, timeoutMs: 240_000 })).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
      const start = text.indexOf("["), end = text.lastIndexOf("]");
      const list = JSON.parse(text.slice(start, end + 1));
      const good = list.filter((r) => typeof r === "string").filter((r) => { try { ruleFiller(d, r); return true; } catch { return false; } });
      if (good.length < 2) throw new Error("fewer than two of the four rules compile");
      rules = good;
    } catch { /* one retry, then this decision goes in without rules and is unmeasurable */ }
  }
  writeFileSync(join(values.out, `${name}.decision.json`), `${JSON.stringify({ _: `Band measurement, 2026-09-21. Decision named by a chat model asked only to list recurring decisions its own programs make - it was told nothing about circuits or codebooks. Codebook drafted by a model and accepted by parseDecision; whether the buckets are honestly computable is a human check. Source line: ${line}`, ...spec }, null, 2)}\n`);
  let legal = 1;
  for (const f of d.fields) legal *= f.values.size;
  ok.push({ name, bits: d.nIn, legal, rules: rules?.length ?? 0 });
  console.log(`fits  ${name.padEnd(28)} ${d.nIn} bits, ${legal} legal, ${rules?.length ?? 0} rules, actions ${d.choices.map((c) => c.choice).join("/")}`);
  if (rules) {
    const path = join(values.out, "rules.json");
    let all = {};
    try { all = JSON.parse(readFileSync(path, "utf8")); } catch { all = { _: "Candidate rules drafted from the codebook ALONE, before any situation was put to any model. Written and committed before the fills - that ordering is the measurement." }; }
    all[name] = rules;
    writeFileSync(path, `${JSON.stringify(all, null, 1)}\n`);
  }
 }
}));
console.log(`\n${ok.length} fitted, ${failed.length} did not, ${spend.used} calls`);
console.log(`total legal rows to fill: ${ok.reduce((s, o) => s + o.legal, 0)}`);
