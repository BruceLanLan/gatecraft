#!/usr/bin/env node
// What do people actually want, and how much of it can this thing do?
//
//   node tools/wish-eval.mjs --wishes wishes.json --provider opencode --model deepseek-v4.1-flash
//
// Every number measured so far rests on twenty sentences written by the same person who wrote
// the templates. This runs the real pipeline over a much larger set that nobody wrote with
// circuits in mind (tools/wishes.mjs), and reports the three numbers that could change what
// gets built next:
//
//   1. how many everyday wishes a circuit can hold at all - if this is small, "small machines"
//      is a niche rather than a product, and the sooner that is known the better;
//   2. how often a buildable wish matches no shape we have - that list IS the missing-shapes
//      list, produced from data instead of from taste;
//   3. how often a buildable wish needs one question back - if it is most of them, the page
//      has to be a conversation rather than a single box.
//
// Nothing here is scored against a hand label, because there is none: the gate is code, and
// what it decides IS the measurement.
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { PROVIDERS } from "../src/describe.mjs";
import { feasibility, signalsFromReply, signalsPrompt } from "../src/feasible.mjs";
import { forkFromReply, forkPrompt } from "../src/route.mjs";
import { shapeName } from "./routing.mjs";
import { takeLock } from "./lock.mjs";

async function ask(prompt, via, maxTokens = 16_000) {
  const response = await fetch(`${via.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(via.key ? { authorization: `Bearer ${via.key}` } : {}),
      ...(PROVIDERS[via.provider]?.headers ? PROVIDERS[via.provider].headers("gatecraft-wish") : {}),
    },
    body: JSON.stringify({ model: via.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()).choices?.[0]?.message?.content ?? "";
}

takeLock();
const { values } = parseArgs({
  options: {
    wishes: { type: "string", default: "wishes.json" },
    provider: { type: "string", default: "opencode" },
    model: { type: "string", default: "deepseek-v4.1-flash" },
    "base-url": { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "6" },
    json: { type: "string" },
  },
});
const baseUrl = values["base-url"] || PROVIDERS[values.provider]?.baseUrl;
const via = { provider: values.provider, model: values.model, baseUrl, key: process.env[PROVIDERS[values.provider]?.keyEnv ?? ""] ?? "" };
const all = JSON.parse(readFileSync(values.wishes, "utf8")).wishes;
const wishes = values.limit ? all.slice(0, Number(values.limit)) : all;

// Concurrency inside ONE process, which is a different thing from two processes fighting
// over the proxy: this one keeps a fixed number of calls in flight and nothing else runs.
// Three hundred wishes at two minutes each is ten hours serially and under two this way.
const lanes = Number(values.concurrency ?? 6);
const rows = new Array(wishes.length);
let next = 0;
let done = 0;

async function measure(index) {
  const wish = wishes[index];
  const row = { ...wish };
  try {
    const verdict = feasibility(signalsFromReply(await ask(signalsPrompt(wish.text), via)));
    row.gate = verdict.ok
      ? "能做"
      : verdict.needsHardware
        ? "缺硬件"
        : verdict.swappable
          ? "换个办法"
          : verdict.no
            ? "做不了"
            : "问一句";
    row.hardware = (verdict.hardware ?? []).map((h) => `${h.name}:${h.wiring}`).join(" ");
    row.bits = verdict.bits;
    row.why = verdict.impossible[0]?.why ?? verdict.questions[0]?.why ?? null;
    row.blocked = verdict.impossible.map((p) => `${p.name}:${p.kind}`).join(" ");
    // Only ask which shape it is when a circuit could hold it at all.
    if (verdict.ok || verdict.ask) {
      row.shape = forkFromReply(await ask(forkPrompt(wish.text, "zh"), via), "zh");
    }
  } catch (error) {
    row.gate = "读不出来";
    row.error = String(error?.message ?? error).slice(0, 60);
  }
  rows[index] = row;
  done += 1;
  if (values.json) writeFileSync(values.json, `${JSON.stringify({ model: via.model, rows: rows.filter(Boolean) }, null, 1)}\n`);
  console.log(`${String(done).padStart(3)}/${wishes.length} ${String(row.gate).padEnd(5)} ${row.shape ? String(shapeName(row.shape)).padEnd(6) : "      "} ${wish.text.slice(0, 38)}`);
}

await Promise.all(Array.from({ length: Math.min(lanes, wishes.length) }, async () => {
  while (next < wishes.length) await measure(next++);
}));
const finished = rows.filter(Boolean);
rows.length = 0;
rows.push(...finished);

const count = (f) => rows.filter(f).length;
// "换个办法" is no longer counted as a way through. On twenty sentences the one swap was
// date-for-a-button and it worked; on real wishes most swaps are sensors in disguise, and
// counting them as buildable would flatter the number by a third.
const buildable = rows.filter((r) => r.gate === "能做" || r.gate === "问一句");
console.log(`\n=== ${rows.length} 条真实愿望，模型 ${via.model} ===`);
console.log(`我们能交付的（按钮进、灯和读数出）: ${buildable.length} 条 = ${(buildable.length / rows.length * 100).toFixed(0)}%`);
console.log(`  直接能做 ${count((r) => r.gate === "能做")}，问一句就能做 ${count((r) => r.gate === "问一句")}`);
console.log(`逻辑能做但缺硬件（要感知或要动真实世界）: ${count((r) => r.gate === "缺硬件")} 条 = ${(count((r) => r.gate === "缺硬件") / rows.length * 100).toFixed(0)}%`);
console.log(`换个说法也许能做（多半仍是传感器）: ${count((r) => r.gate === "换个办法")} 条`);
console.log(`电路做不了: ${count((r) => r.gate === "做不了")} 条 = ${(count((r) => r.gate === "做不了") / rows.length * 100).toFixed(0)}%`);
console.log(`读不出来: ${count((r) => r.gate === "读不出来")} 条`);

const blockers = {};
for (const r of rows.filter((x) => x.gate === "做不了")) for (const b of String(r.blocked).split(" ").filter(Boolean)) {
  const kind = b.split(":").pop();
  blockers[kind] = (blockers[kind] ?? 0) + 1;
}
console.log(`\n挡住它们的是什么:`, Object.entries(blockers).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("、") || "—");

console.log("\n=== 按场景（这才是定位该看的表）===");
for (const scene of [...new Set(rows.map((r) => r.scene))]) {
  const sub = rows.filter((r) => r.scene === scene);
  const can = sub.filter((r) => r.gate === "能做" || r.gate === "问一句").length;
  const hw = sub.filter((r) => r.gate === "缺硬件").length;
  console.log(`  ${scene.padEnd(6)} n=${String(sub.length).padStart(3)}  能交付 ${(can / sub.length * 100).toFixed(0).padStart(3)}%   缺硬件 ${(hw / sub.length * 100).toFixed(0).padStart(3)}%`);
}

const shaped = buildable.filter((r) => r.shape);
const none = shaped.filter((r) => r.shape === "none");
console.log(`\n=== 能做的里面，现成形状够不够用 ===`);
console.log(`问到了形状的 ${shaped.length} 条：对上模板 ${shaped.length - none.length}，都不是 ${none.length} = ${shaped.length ? (none.length / shaped.length * 100).toFixed(0) : 0}%`);
const used = {};
for (const r of shaped) if (r.shape !== "none") used[r.shape] = (used[r.shape] ?? 0) + 1;
console.log("用上的模板:", Object.entries(used).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${shapeName(k)} ${n}`).join("、") || "—");
console.log(`\n=== 「都不是」的那些（先别当成缺形状：上一轮这里装的全是漏网的做不到）===`);
for (const r of none.slice(0, 40)) console.log(`  ${r.text.slice(0, 44)}`);
if (values.json) writeFileSync(values.json, `${JSON.stringify({ model: via.model, rows }, null, 1)}\n`);
