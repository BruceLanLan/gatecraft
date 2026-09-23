#!/usr/bin/env node
// The same two routing questions as tools/jev-route-eval.mjs, asked of an ordinary chat model.
//
//   node tools/route-eval.mjs --base-url http://127.0.0.1:11434/v1 --model qwen2.5-coder:3b
//   ANTHROPIC_API_KEY=... node tools/route-eval.mjs --provider anthropic --model ...
//
// Why bother, when a typed decision model is the right tool: because this is the cheapest way
// to find out whether the SHAPE of the product works. Picking one of three, or one of fifteen,
// is a far smaller job than writing a program - so if a small local model can route, the spine
// holds and a purpose-built typed model will only make it faster and steadier. If a small model
// cannot route, we know how big a gap the typed model has to close before it is worth paying
// for. Nothing here needs a key when the model is on this machine.
//
// Each sentence is asked several times: how often the answers agree is a measured stand-in for
// sureness, unlike a chat model's own claim about how sure it is.
import { parseArgs } from "node:util";
import { PROVIDERS } from "../src/describe.mjs";
import { DOOR, DOOR_BINARY, DOOR_TRUTH, FORK_TRUTH, PASS, doorFromBinaries, familyQuestion, fork, memberQuestion, report, shapeName } from "./routing.mjs";
import { takeLock } from "./lock.mjs";



// The names are English and the descriptions are Chinese, so say plainly, twice, that the
// answer is one of the names: a small model otherwise answers in Chinese and cannot be read.
const prompt = (question, sentence) => `${question.instructions}？

${Object.entries(question.criteria).map(([id, text]) => `${id} = ${text}`).join("\n")}

句子：${sentence}

只回答一个英文代号，就是上面等号左边那些词里的一个：${Object.keys(question.criteria).join(" / ")}
不要解释，不要翻译，不要标点，只回那一个词。`;

async function pick(question, sentence, via) {
  const body = {
    model: via.model,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt(question, sentence) }],
  };
  const response = await fetch(`${via.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(via.key ? { authorization: `Bearer ${via.key}` } : {}),
      ...(PROVIDERS[via.provider]?.headers ? PROVIDERS[via.provider].headers("gatecraft-eval") : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
  const text = (await response.json()).choices?.[0]?.message?.content ?? "";
  const ids = Object.keys(question.criteria);
  // The reply may carry quotes, a full stop or a stray word; take the first known name in it.
  const hit = ids
    .map((id) => ({ id, at: text.toLowerCase().indexOf(id.toLowerCase()) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  return hit ? hit.id : `??${text.trim().slice(0, 20)}`;
}

async function askRepeatedly(question, truth, via, samples, label, name) {
  const rows = [];
  for (const [sentence, want] of truth) {
    const votes = [];
    for (let i = 0; i < samples; i += 1) {
      try {
        votes.push(await pick(question, sentence, via));
      } catch (error) {
        votes.push(`!!${error.message.slice(0, 40)}`);
      }
    }
    const tally = new Map();
    for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
    const [said, count] = [...tally].sort((a, b) => b[1] - a[1])[0];
    const right = want.includes(said);
    rows.push({
      sentence,
      said: name(said),
      want: want.map(name).join(" 或 "),
      right,
      confidence: count / votes.length,
      p: want.reduce((sum, id) => sum + (tally.get(id) ?? 0), 0) / votes.length,
      votes,
    });
    console.log(`${label} ${right ? "对" : "错"} ${count}/${votes.length}  ${sentence} → ${said}`);
  }
  return rows;
}


// A yes/no question, asked the same way: something concrete to look for, one word back.
const yesNoPrompt = (instructions, sentence) => `${instructions}？

句子：${sentence}

只回答一个字：是 或 否。不要解释。`;

async function yesNo(instructions, sentence, via) {
  const response = await fetch(`${via.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(via.key ? { authorization: `Bearer ${via.key}` } : {}),
      ...(PROVIDERS[via.provider]?.headers ? PROVIDERS[via.provider].headers("gatecraft-eval") : {}),
    },
    body: JSON.stringify({ model: via.model, max_tokens: 4000, messages: [{ role: "user", content: yesNoPrompt(instructions, sentence) }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  const text = ((await response.json()).choices?.[0]?.message?.content ?? "").trim();
  if (/^(是|yes|true|1)/i.test(text)) return true;
  if (/^(否|不|no|false|0)/i.test(text)) return false;
  return /是|yes/i.test(text) ? true : false;
}

const vote = (list) => list.filter(Boolean).length * 2 > list.length;

// The door as two binaries instead of one three-way choice.
async function doorBinary(via, samples) {
  const rows = [];
  for (const [sentence, want] of DOOR_TRUTH) {
    const answers = {};
    let agreement = 1;
    for (const [key, q] of Object.entries(DOOR_BINARY)) {
      const votes = [];
      for (let i = 0; i < samples; i += 1) votes.push(await yesNo(q.instructions, sentence, via).catch(() => false));
      answers[key] = vote(votes);
      const same = votes.filter((v) => v === answers[key]).length;
      agreement = Math.min(agreement, same / votes.length);
    }
    const said = doorFromBinaries(answers);
    const right = want.includes(said);
    rows.push({ sentence, said, want: want.join(" 或 "), right, confidence: agreement, p: right ? agreement : 1 - agreement });
    console.log(`门口2 ${right ? "对" : "错"} ${agreement.toFixed(2)}  ${sentence} → ${said}（戏=${answers.theatre ? "是" : "否"} 多台=${answers.split ? "是" : "否"}）`);
  }
  return rows;
}

// The fork in two steps: which kind, then which one of that kind.
async function forkTwoStage(via, samples) {
  const rows = [];
  for (const [sentence, want] of FORK_TRUTH) {
    const famVotes = [];
    for (let i = 0; i < samples; i += 1) famVotes.push(await pick(familyQuestion(), sentence, via));
    const famTally = new Map();
    for (const v of famVotes) famTally.set(v, (famTally.get(v) ?? 0) + 1);
    const [family, famCount] = [...famTally].sort((a, b) => b[1] - a[1])[0];
    let said = "none";
    let memCount = samples;
    if (family !== "none" && !family.startsWith("??")) {
      const question = memberQuestion(family);
      const memVotes = [];
      for (let i = 0; i < samples; i += 1) memVotes.push(await pick(question, sentence, via));
      const memTally = new Map();
      for (const v of memVotes) memTally.set(v, (memTally.get(v) ?? 0) + 1);
      [said, memCount] = [...memTally].sort((a, b) => b[1] - a[1])[0];
    }
    const right = want.includes(said);
    const confidence = (famCount / samples) * (memCount / samples);
    rows.push({ sentence, said: shapeName(said), want: want.map(shapeName).join(" 或 "), right, confidence, p: right ? confidence : 0 });
    console.log(`分流2 ${right ? "对" : "错"} ${confidence.toFixed(2)}  ${sentence} → ${family} / ${said}`);
  }
  return rows;
}


// The door, asked without asking it: if the fork cannot find a shape, that IS the answer.
// The three-way door needs the model to know what circuits cannot do, which neither size of
// local model does. "Which of our shapes is this" needs no such knowledge, and "none of them"
// is the refusal we were fishing for.
async function doorViaFork(via, samples) {
  const question = fork();
  const rows = [];
  for (const [sentence, want] of DOOR_TRUTH) {
    const votes = [];
    for (let i = 0; i < samples; i += 1) votes.push(await pick(question, sentence, via));
    const tally = new Map();
    for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
    const [choice, count] = [...tally].sort((a, b) => b[1] - a[1])[0];
    const said = choice === "none" || String(choice).startsWith("??") ? "not-fits" : "fits";
    const wanted = want[0] === "fits" ? "fits" : "not-fits";
    const right = said === wanted;
    rows.push({ sentence, said: `${said}（${shapeName(choice)}）`, want: wanted, right, confidence: count / samples, p: right ? count / samples : 0 });
    console.log(`门口3 ${right ? "对" : "错"} ${(count / samples).toFixed(2)}  ${sentence} → ${choice}`);
  }
  return rows;
}

takeLock();

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "openai" },
    model: { type: "string" },
    "base-url": { type: "string", default: "http://127.0.0.1:11434/v1" },
    samples: { type: "string", default: "3" },
    mode: { type: "string", default: "flat" }, // flat | v2
    json: { type: "string" },
  },
});
// A named provider brings its own address; without one, assume the model is on this machine.
const baseUrl = values["base-url"] || (values.provider !== "openai" ? PROVIDERS[values.provider]?.baseUrl : null) || "http://127.0.0.1:11434/v1";
const via = {
  provider: values.provider,
  model: values.model,
  baseUrl,
  key: process.env[PROVIDERS[values.provider]?.keyEnv ?? ""] ?? "",
};
const samples = Number(values.samples);

const v2 = values.mode === "v2";
const viaFork = values.mode === "door-via-fork";
const door = viaFork
  ? await doorViaFork(via, samples)
  : v2
    ? await doorBinary(via, samples)
    : await askRepeatedly(DOOR, DOOR_TRUTH, via, samples, "门口", (id) => id);
const fk = viaFork ? [] : v2 ? await forkTwoStage(via, samples) : await askRepeatedly(fork(), FORK_TRUTH, via, samples, "分流", shapeName);

const doorName = viaFork ? "门口 · 由分流代答（问不出形状就是做不了）" : v2 ? "门口 · 两道是非题" : "门口（一颗装得下 / 要拆 / 是戏）";
const doorOk = report(doorName, door, PASS.door);
const forkOk = fk.length ? report(v2 ? "分流 · 先问类再问成员" : "分流（14 个模板 + 都不是）", fk, PASS.fork) : true;
const unreadable = [...door, ...fk].filter((r) => String(r.said).startsWith("??")).length;
console.log(`\n${(door.length + fk.length) * samples} 次调用，模型 ${via.model}。${unreadable ? `其中 ${unreadable} 句没回代号、读不出来——那是听不懂题，不是选错。` : ""}`);
console.log(doorOk && forkOk
  ? "两道都过了：形状优先这条主线立得住，Jev 这类模型只会让它更快更稳。"
  : "至少一道没过：这个模型当不了路由器。换强模型或换专门的分类模型才知道差距有多大。");
if (values.json) (await import("node:fs")).writeFileSync(values.json, `${JSON.stringify({ model: via.model, samples, door, fork: fk }, null, 1)}\n`);
