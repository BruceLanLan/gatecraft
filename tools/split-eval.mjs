#!/usr/bin/env node
// Does asking for one small machine at a time fix the sentences a small model never builds?
//
//   node tools/split-eval.mjs --model qwen2.5-coder:3b --rounds 5
//
// The three sentences below were built 0, 0 and 1 times out of eleven whole-sentence attempts
// (docs/findings.md). They have the same shape: two or three machines that each
// mind their own business, which the model tries to fuse into one program with state crossing
// between them - and then contradicts its own examples, the commonest failure of all.
//
// Two ways of splitting, so the gap between them is the number that matters:
//   by hand  - the sub-sentences below, written before any of this ran. This is the ceiling.
//   by model - ask it what the parts are, then build each part it names.
//
// The wiring must stay free of logic: one piece's output is the next piece's input on the same
// tick, nothing else. That is what keeps the proof honest - every piece is still proven on
// every row of its own table, and the page in between only carries values, it never decides.
import { parseArgs } from "node:util";
import { PROVIDERS } from "../src/describe.mjs";
import { attempt } from "./muggle-eval.mjs";
import { takeLock } from "./lock.mjs";



export const CASES = [
  {
    sentence: "两队比分板，各有加一分和减一分",
    pieces: [
      "A 队分数：按加一分加 1，按减一分减 1，范围 0 到 9，到头就不再动",
      "B 队分数：按加一分加 1，按减一分减 1，范围 0 到 9，到头就不再动",
      "给两个 4 位数 a 和 b，输出 a 是不是大于 b",
    ],
    wiring: "两个分数的输出，同一拍接进比较器的两个输入",
  },
  {
    sentence: "红绿灯：红 3 拍、绿 3 拍、黄 1 拍",
    pieces: [
      "拍数计数器：每按一拍加 1，到 6 之后回到 0",
      "给一个 0 到 6 的数：0、1、2 亮红灯，3、4、5 亮绿灯，6 亮黄灯",
    ],
    wiring: "计数器的输出，同一拍接进灯的输入",
  },
  {
    sentence: "投币 5 毛买一瓶水，够了就出货并找零",
    pieces: [
      "余额：投一个五毛加 1，投一块加 2，到了 3 就清零",
      "给余额和这次投的币（五毛记 1、一块记 2），输出够不够 3 出货，以及超出多少",
    ],
    wiring: "余额这一位状态，同一拍接进出货判断的输入",
  },
];

const chat = async (prompt, via) => {
  const response = await fetch(`${via.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(via.key ? { authorization: `Bearer ${via.key}` } : {}) },
    body: JSON.stringify({ model: via.model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()).choices?.[0]?.message?.content ?? "";
};

const SPLIT_PROMPT = (sentence) => `下面这句话描述的东西，要用几台各管各的小机器才做得出来？

每台小机器单独写一行，一行就是一句完整的话，说清楚它有哪些输入、输出什么、要记住什么。
每台机器都要小到可以自己单独做出来，机器之间只允许「一台的输出当另一台的输入」，不许互相纠缠。
不要编号，不要解释，不要空行，只写这几行。

句子：${sentence}`;

const asPieces = (reply) =>
  reply
    .split("\n")
    .map((line) => line.replace(/^\s*[-*\d.、)]+\s*/, "").trim())
    .filter((line) => line.length >= 8 && !/^[#`]/.test(line))
    .slice(0, 4);

const buildAll = async (pieces, via) => {
  const out = [];
  for (const piece of pieces) {
    const r = await attempt(piece, via, 3);
    out.push({ piece, ...r });
  }
  return out;
};

takeLock();

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "openai" },
    model: { type: "string" },
    "base-url": { type: "string", default: "http://127.0.0.1:11434/v1" },
    rounds: { type: "string", default: "5" },
    json: { type: "string" },
  },
});
const via = {
  provider: values.provider,
  model: values.model,
  baseUrl: values["base-url"],
  key: process.env[PROVIDERS[values.provider]?.keyEnv ?? ""] ?? "",
};
const rounds = Number(values.rounds);

const results = [];
for (const item of CASES) {
  const byHand = [];
  const byModel = [];
  for (let round = 1; round <= rounds; round += 1) {
    const hand = await buildAll(item.pieces, via);
    byHand.push(hand);
    console.log(`手拆 ${round} ${item.sentence}: ${hand.map((p) => (p.result === "built" ? "成" : "败")).join("")}`);

    let named = [];
    try {
      named = asPieces(await chat(SPLIT_PROMPT(item.sentence), via));
    } catch (error) {
      named = [];
    }
    const mine = named.length ? await buildAll(named, via) : [];
    byModel.push({ named, pieces: mine });
    console.log(`自拆 ${round} ${item.sentence}: 说了 ${named.length} 台 → ${mine.map((p) => (p.result === "built" ? "成" : "败")).join("") || "无"}`);
  }
  results.push({ sentence: item.sentence, wiring: item.wiring, pieces: item.pieces, byHand, byModel });
}

console.log("\n=== 手拆（我写的子句子，这是天花板）===");
let handPieces = 0;
let handTotal = 0;
for (const r of results) {
  const wholeRounds = r.byHand.filter((round) => round.every((p) => p.result === "built")).length;
  r.pieces.forEach((piece, i) => {
    const built = r.byHand.filter((round) => round[i].result === "built").length;
    handPieces += built;
    handTotal += r.byHand.length;
    console.log(`  ${built}/${r.byHand.length}  ${piece}`);
  });
  console.log(`  → ${r.sentence}：${wholeRounds}/${r.byHand.length} 轮整句拆得成（接线：${r.wiring}）\n`);
}
console.log(`手拆每块合计 ${handPieces}/${handTotal}`);

console.log("\n=== 自拆（模型自己说有几台）===");
for (const r of results) {
  const ok = r.byModel.filter((m) => m.pieces.length && m.pieces.every((p) => p.result === "built")).length;
  const counts = r.byModel.map((m) => m.named.length).join(",");
  console.log(`  ${ok}/${r.byModel.length} 轮全成，每轮说了几台：${counts}  ${r.sentence}`);
  const sample = r.byModel.find((m) => m.named.length)?.named ?? [];
  for (const line of sample) console.log(`      例：${line.slice(0, 60)}`);
}

console.log(`\n判据（定在跑之前）：手拆每块 ≥ 12/15，且自拆至少 1/3 的轮次能全成。模型 ${via.model}。`);
if (values.json) (await import("node:fs")).writeFileSync(values.json, `${JSON.stringify(results, null, 1)}\n`);
