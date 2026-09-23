#!/usr/bin/env node
// Does the structural gate say no to the right sentences, and yes to all the others?
//
//   node tools/gate-eval.mjs --base-url http://127.0.0.1:11434/v1 --model qwen2.5-coder:3b
//
// The verdict itself is code and cannot be wrong (src/feasible.mjs). What can be wrong is the
// naming it is given: the model is asked only what goes in and what comes out, with a kind on
// each, and if it calls a chat message "a number" the gate will happily let a chat room
// through. So this measures the naming, which is the whole risk.
//
// The mark, written down before the first run: every sentence no circuit can do is refused,
// and no sentence that fits is turned away. It is decidable, so anything less than that is a
// naming failure worth reading one by one, not a statistic to average.
import { parseArgs } from "node:util";
import { PROVIDERS } from "../src/describe.mjs";
import { feasibility, refusalWords, signalsFromReply, signalsPrompt } from "../src/feasible.mjs";
import { SENTENCES } from "./muggle-eval.mjs";
import { takeLock } from "./lock.mjs";
import { writeFileSync } from "node:fs";



async function nameSignals(sentence, via, maxTokens = 16_000) {
  const response = await fetch(`${via.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(via.key ? { authorization: `Bearer ${via.key}` } : {}),
      ...(PROVIDERS[via.provider]?.headers ? PROVIDERS[via.provider].headers("gatecraft-eval") : {}),
    },
    // Generous: a model that thinks before answering can spend tens of thousands of
    // characters doing it, and a tight cap truncates the answer rather than saving anything.
    body: JSON.stringify({ model: via.model, max_tokens: maxTokens, messages: [{ role: "user", content: signalsPrompt(sentence) }] }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return signalsFromReply((await response.json()).choices?.[0]?.message?.content ?? "");
}

// One retry with more room. The two sentences about money were the only ones a thinking model
// could not answer, and both times the thinking ran long enough to push the answer out - so
// the first thing to try is simply more room, not a different question.
async function nameSignalsTwice(sentence, via) {
  try {
    return await nameSignals(sentence, via);
  } catch (first) {
    return await nameSignals(sentence, via, 32_000).catch(() => { throw first; });
  }
}

takeLock();

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "openai" },
    model: { type: "string" },
    "base-url": { type: "string" }, // default: the provider's own, or this machine's Ollama
    samples: { type: "string", default: "1" },
    json: { type: "string" },
  },
});
// A named provider brings its own address; without one, assume the model is on this machine.
const baseUrl = values["base-url"] || (values.provider !== "openai" ? PROVIDERS[values.provider]?.baseUrl : null) || "http://127.0.0.1:11434/v1";
const via = { provider: values.provider, model: values.model, baseUrl, key: process.env[PROVIDERS[values.provider]?.keyEnv ?? ""] ?? "" };
const samples = Number(values.samples);

const rows = [];
for (const [sentence, verdict] of SENTENCES) {
  const wanted = verdict === "fits";
  const tries = [];
  for (let i = 0; i < samples; i += 1) {
    try {
      const signals = await nameSignalsTwice(sentence, via);
      tries.push({ signals, verdict: feasibility(signals) });
    } catch (error) {
      tries.push({ error: String(error?.message ?? error).slice(0, 80) });
    }
  }
  // An extraction that failed is not a refusal: counting a broken reply as "the gate said no"
  // would flatter the gate on exactly the sentences it exists to be judged on. And only a
  // sentence where EVERY sample failed counts as unreadable. One flaky reply out of three was
  // condemning the whole sentence, which is both wrong and quietly pessimistic: the samples
  // exist precisely so that one bad draw does not decide anything.
  const good = tries.filter((t) => t.verdict);
  const broke = good.length === 0;
  // A refusal must hold every time to count as one; a question anywhere means we would have
  // asked rather than refused, so the sentence still has a way through.
  const refused = good.length > 0 && good.every((t) => t.verdict.no);
  const straight = good.length > 0 && good.every((t) => t.verdict.ok);
  // A refusal where every blocker has a stand-in is a way through too: on the page it is one
  // button that rewrites the sentence. Counted separately so it is never mistaken for a
  // sentence that sailed through.
  const swappable = refused && good.every((t) => t.verdict.swappable);
  const said = broke ? "读不出来" : swappable ? "换个办法" : refused ? "做不了" : straight ? "能做" : "问一句";
  // A sentence no circuit can do must be refused outright. A sentence that fits may go
  // straight through or come back with one question - both are the gate working.
  const right = broke ? false : wanted ? said !== "做不了" : said === "做不了" || said === "换个办法";
  const shown = tries.find((t) => t.verdict) ?? {};
  rows.push({
    sentence,
    wanted: wanted ? "能做" : "做不了",
    said,
    broke,
    right,
    bits: shown.verdict?.bits ?? null,
    why: shown.verdict?.impossible?.[0]?.why ?? shown.verdict?.questions?.[0]?.why ?? null,
    words: shown.verdict && !shown.verdict.ok ? refusalWords(shown.verdict) : "",
    signals: shown.signals ?? null,
    named: shown.signals ? [...shown.signals.inputs, ...shown.signals.remembers, ...shown.signals.outputs].map((x) => `${x.name}:${x.kind}`).join(" ") : (tries[0]?.error ?? ""),
  });
  // Write after every sentence. A run that dies at the seventeenth of twenty should not take
  // the first sixteen with it, and long remote runs do die.
  if (values.json) writeFileSync(values.json, `${JSON.stringify({ model: via.model, samples, rows }, null, 1)}\n`);
  const r = rows.at(-1);
  console.log(`${r.right ? "对" : r.broke ? "坏" : "错"} ${r.said.padEnd(4)} ${sentence}${r.words ? `  — ${r.words.split("\n")[0]}` : `  — ${r.bits} 位`}`);
}

const theatre = rows.filter((r) => r.wanted === "做不了");
const fits = rows.filter((r) => r.wanted === "能做");
const leaks = theatre.filter((r) => !r.right && !r.broke);
const turnedAway = fits.filter((r) => !r.right && !r.broke);
const broken = rows.filter((r) => r.broke);
const straightThrough = fits.filter((r) => r.said === "能做").length;
const afterAsking = fits.filter((r) => r.said === "问一句").length;
const afterSwap = fits.filter((r) => r.said === "换个办法").length;
console.log(`\n做不了的 ${theatre.filter((r) => r.right).length}/${theatre.length} 被拦下（漏 ${leaks.length}）。`);
console.log(`能做的 ${fits.length} 句：${straightThrough} 句直接放行，${afterAsking} 句问一句就能放行，${afterSwap} 句换个办法一键可通，${turnedAway.length} 句被错拦，${fits.filter((r) => r.broke).length} 句读不出来。`);
console.log(`模型 ${via.model}，每句 ${samples} 次。`);
if (leaks.length) {
  console.log("\n漏进来的（最危险的一类）：");
  for (const r of leaks) console.log(`  ${r.sentence}\n      它命名成: ${r.named}`);
}
if (turnedAway.length) {
  console.log("\n误拦的（用户重说一遍就行，但仍要看）：");
  for (const r of turnedAway) console.log(`  ${r.sentence}\n      ${r.words}\n      它命名成: ${r.named}`);
}
console.log(`\n判据（定在跑之前）：做不了的全拦、能做的全放（直接放行或问一句都算）。${!leaks.length && !turnedAway.length && !broken.length ? "过了。" : "没过。"}`);
if (values.json) writeFileSync(values.json, `${JSON.stringify({ model: via.model, samples, rows }, null, 1)}\n`);
