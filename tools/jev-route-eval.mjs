#!/usr/bin/env node
// Can a typed decision model stand at the door and at the fork? (The questions, the ground
// truth and the scoring are in tools/routing.mjs, shared with tools/route-eval.mjs so that
// every kind of model is asked exactly the same thing.)
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node tools/jev-route-eval.mjs
//   TYPESAFE_API_KEY=... node tools/jev-route-eval.mjs --direct
//
// Jev is served both by TypeSafe directly and through Cloudflare Workers AI; the model is the
// same and only the envelope differs, so both are here and the Cloudflare one is the default
// because that is where the waitlist lets people in.
//
// Why it matters: a sentence no circuit can hold currently costs the person 5 to 40 seconds
// and ends in a failure. A model that answers with a type cannot invent a template that does
// not exist, and a wrong pick costs nothing here - whatever it picks is still compiled and
// proven on every row before anyone sees it.
//
// The key stays the caller's own: read from the environment or from a file outside this repo,
// never written anywhere, never printed, never committed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TEMPLATES } from "../src/templates.mjs";
import { DOOR, DOOR_TRUTH, FORK_TRUTH, PASS, fork, report, shapeName } from "./routing.mjs";

const CONFIG = join(homedir(), ".config", "gatecraft");
const fileValue = (name) => {
  try {
    return readFileSync(join(CONFIG, name), "utf8").trim() || null;
  } catch {
    return null;
  }
};

// Cloudflare wraps the same model: the questions carry a type, and the answer may arrive
// inside a "result" envelope.
const backends = {
  cloudflare: {
    need: "CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN（或 ~/.config/gatecraft/cloudflare.account 与 cloudflare.token）",
    make() {
      const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || fileValue("cloudflare.account");
      const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || fileValue("cloudflare.token");
      if (!account || !token) return null;
      return {
        url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`,
        token,
        body: (state, question) => ({ model: "typesafe/jev", input: { state, questions: { q: { type: "choice", ...question } } } }),
      };
    },
  },
  direct: {
    need: "TYPESAFE_API_KEY（或 ~/.config/gatecraft/typesafe.key）",
    make() {
      const token = process.env.TYPESAFE_API_KEY?.trim() || fileValue("typesafe.key");
      if (!token) return null;
      return {
        url: "https://api.typesafe.ai/v1/systemone",
        token,
        body: (state, question) => ({ state, questions: { q: { type: "choice", ...question } } }),
      };
    },
  },
};

async function ask(via, state, question, timeoutMs = 30_000) {
  const response = await fetch(via.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${via.token}` },
    body: JSON.stringify(via.body(state, question)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  // Workers AI wraps the model's own reply in a result envelope, sometimes twice.
  const answer = (body.result?.result ?? body.result ?? body).answers?.q;
  if (!answer) throw new Error(`没有 answers.q：${text.slice(0, 200)}`);
  return answer;
}

async function run(question, truth, via, label, name) {
  const rows = [];
  for (const [sentence, want] of truth) {
    const answer = await ask(via, sentence, question);
    const said = answer.choice;
    const right = want.includes(said);
    rows.push({
      sentence,
      said: name(said),
      want: want.map(name).join(" 或 "),
      right,
      confidence: answer.confidence ?? 0,
      p: want.reduce((best, id) => Math.max(best, answer.probabilities?.[id] ?? 0), 0),
    });
    console.log(`${label} ${right ? "对" : "错"} ${(answer.confidence ?? 0).toFixed(2)}  ${sentence} → ${said}`);
  }
  return rows;
}

const { values } = parseArgs({
  options: { lang: { type: "string", default: "zh" }, direct: { type: "boolean", default: false }, json: { type: "string" } },
});
const which = values.direct ? "direct" : "cloudflare";
const via = backends[which].make();
if (!via) {
  console.error(`要 ${backends[which].need}。`);
  console.error("这条路是谁用谁买单：gatecraft 自己不持有、不代付任何模型的 key。");
  process.exit(1);
}

const door = await run(DOOR, DOOR_TRUTH, via, "门口", (id) => id);
const fk = await run(fork(values.lang), FORK_TRUTH, via, "分流", shapeName);

const doorOk = report("门口（一颗装得下 / 要拆 / 是戏）", door, PASS.door);
const forkOk = report(`分流（${TEMPLATES.length} 个模板 + 都不是）`, fk, PASS.fork);
console.log(`\n${door.length + fk.length} 次调用。`);
console.log(doorOk && forkOk
  ? "两道都过了：形状优先这条主线立得住，可以照它改首屏和模板结构。"
  : "至少一道没过：路由当不了主线，模型造句仍是主线，逃生口变正门。");
if (values.json) (await import("node:fs")).writeFileSync(values.json, `${JSON.stringify({ door, fork: fk }, null, 1)}\n`);
