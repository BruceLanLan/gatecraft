#!/usr/bin/env node
// Twenty sentences I made up is the weakest link in everything measured so far.
//
//   node tools/wishes.mjs --provider opencode --model glm-5.3 --count 120 --out wishes.json
//
// This asks a model for what ORDINARY PEOPLE would want a little gadget to do, and it is
// deliberately never told what a circuit is, what our templates are, or that anything will be
// built. Telling it would bias the set toward things we can already do, which is precisely
// the number we are trying to measure. The prompt asks for everyday wishes; whether they can
// be built is decided later, by the compiler.
//
// Generating the set with one model and testing others on it is not neutral either - a model
// writes the kind of sentence a model finds natural. It is still a large improvement on a set
// of twenty written by the person who also wrote the templates, and the sentences are saved
// so a human can read them and throw out the ones that are not real wishes.
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { PROVIDERS } from "../src/describe.mjs";
import { takeLock } from "./lock.mjs";

const SCENES = [
  ["家里", "厨房、客厅、卧室、阳台、宠物、小孩、进门出门"],
  ["店里", "小卖部、咖啡店、理发店、洗衣店、排队、收银、库存"],
  ["玩的", "桌游、小游戏、比赛计分、抽签、猜谜、玩具"],
  ["办公", "会议、打卡、投票、排班、提醒、工位"],
  ["身体和习惯", "喝水、吃药、运动、睡觉、戒烟、记次数"],
  ["车和路", "车位、红绿灯、电梯、闸机、门禁"],
  ["学校", "课堂、答题、值日、考勤、小组比赛"],
  ["杂七杂八", "想到什么算什么，越像真人随口说的越好"],
];

const wishPrompt = (scene, hint, n) => `想象你在街上问一百个普通人：「如果能给你做一个小玩意儿，你想要它干什么？」

现在写 ${n} 条这样的回答，场景是「${scene}」（${hint}）。

要求：
- 用**普通人随口说话的语气**，一句话，不要书面语，不要编号。
- 写他们**想要的效果**，不要写怎么实现，不要提电路、芯片、程序、传感器这些词。
- 什么都可以想要——离谱的、做不到的、要联网的、要存东西的，都照写，**不要只写简单的**。
- ${n} 条要彼此不同，不要同一件事换个说法。

一行一条，只写这 ${n} 行。`;

async function ask(prompt, via) {
  const response = await fetch(`${via.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(via.key ? { authorization: `Bearer ${via.key}` } : {}),
      ...(PROVIDERS[via.provider]?.headers ? PROVIDERS[via.provider].headers("gatecraft-wishes") : {}),
    },
    body: JSON.stringify({ model: via.model, max_tokens: 16_000, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 120)}`);
  return (await response.json()).choices?.[0]?.message?.content ?? "";
}

// A wish is one line of ordinary speech. Numbering, bullets and stage directions are stripped;
// anything too short to be a wish, or long enough to be a paragraph, is dropped.
export const readWishes = (reply) =>
  String(reply ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•\d]+[.、)]?\s*/, "").replace(/^["“”「」]|["“”「」]$/g, "").trim())
    .filter((line) => line.length >= 6 && line.length <= 60 && !/^[#`>]/.test(line) && !/^(好的|以下|这里|场景)/.test(line));

if (import.meta.url === `file://${process.argv[1]}`) {
  takeLock();
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "opencode" },
      model: { type: "string", default: "glm-5.3" },
      "base-url": { type: "string" },
      count: { type: "string", default: "120" },
      out: { type: "string", default: "wishes.json" },
    },
  });
  const baseUrl = values["base-url"] || PROVIDERS[values.provider]?.baseUrl;
  const via = { provider: values.provider, model: values.model, baseUrl, key: process.env[PROVIDERS[values.provider]?.keyEnv ?? ""] ?? "" };
  const perScene = Math.ceil(Number(values.count) / SCENES.length);

  const wishes = [];
  const seen = new Set();
  for (const [scene, hint] of SCENES) {
    // A 503 in the middle of generating is the server having a moment, not an answer. Four of
    // eight scenes came back empty the first time for exactly that reason - and they were the
    // four where small machines actually live, which would have skewed the whole measurement.
    let got = [];
    for (let go = 1; go <= 3; go += 1) {
      try {
        got = readWishes(await ask(wishPrompt(scene, hint, perScene), via));
        if (got.length) break;
      } catch (error) {
        console.log(`${scene}: 第 ${go} 次取不到（${error.message.slice(0, 50)}）`);
        if (go < 3) await new Promise((r) => setTimeout(r, 5000 * go));
      }
    }
    if (!got.length) {
      console.log(`${scene}: 三次都没取到，跳过`);
      continue;
    }
    let fresh = 0;
    for (const text of got) {
      const key = text.replace(/[，。、！？\s]/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      wishes.push({ text, scene });
      fresh += 1;
    }
    console.log(`${scene}: 拿到 ${got.length} 条，去重后留 ${fresh}`);
  }

  writeFileSync(values.out, `${JSON.stringify({ model: via.model, when: new Date().toISOString().slice(0, 10), wishes }, null, 1)}\n`);
  console.log(`\n共 ${wishes.length} 条，写进 ${values.out}。`);
  console.log("这些是「人想要什么」，不是「能不能做」——能不能做由编译器判，不由写它们的模型判。");
}
