#!/usr/bin/env node
// How far do everyday sentences get? Twenty of them, classified by hand first, and the ones a
// single circuit should hold are run end to end: model, program, compile, proof.
//
//   node tools/muggle-eval.mjs --base-url http://127.0.0.1:11434/v1 --model qwen2.5-coder:3b --repeat 3
//   ANTHROPIC_API_KEY=... node tools/muggle-eval.mjs --provider anthropic --model ... --repeat 3
//
// This asks a different question from tools/nl-eval.mjs, which checks whether the circuit is
// RIGHT against a hand-written answer. Here nothing is compared to a hand-written answer: a
// sentence counts only if it reaches a circuit proven on every row, and every other outcome is
// recorded as what stopped it. Use --repeat: one pass says very little (2026-09-18, on a 3B
// model, the same ten sentences built six on one pass and none on the next).
//
// It spends model calls on the caller's own account.
import { parseArgs } from "node:util";
import { PROVIDERS, askModel, askModelBestOf } from "../src/describe.mjs";
import { parseProgram } from "../src/expr.mjs";
import { compileSpec } from "../src/job.mjs";
import { takeLock } from "./lock.mjs";



// "verdict" is the hand classification:
//   fits    - one circuit of at most 20 input+state bits holds it
//   split   - it needs several circuits, or a wider number than the ceiling allows
//   theatre - it wants text, network or accounts, so no circuit will ever do it
//
// 2026-09-19: five sentences were marked "split" by hand and every one of them was wrong.
// A typed decision model called them all "fits", so each was written out as a program and
// put through this compiler, which is the only judge that counts here - "fits" means our
// own compiler proves it on every row, not that it feels small. All five proved:
//   骰子 26 NAND + 3 latches · 摄氏转华氏 146 NAND · 猜数字 90 NAND + 4 latches
//   售货机找零 85 NAND · 洗衣机 81 NAND + 6 latches
// The "split" class is empty at this ceiling, and the hand classification was the thing
// that was wrong, not the model. The verdicts below are the corrected ones.
export const SENTENCES = [
  ["会员卡满十次送一杯，按一下盖一个章", "fits"],
  ["三个评委按下通过，两个以上就算过", "fits"],
  ["房间温度低于 20 度开暖气，高于 24 度关", "fits"],
  ["密码锁：按对四位数字才开", "fits"],
  ["两队比分板，各有加一分和减一分", "fits"],
  ["红绿灯：红 3 拍、绿 3 拍、黄 1 拍", "fits"],
  ["投币 5 毛买一瓶水，够了就出货并找零", "fits"],
  ["骰子：显示 1 到 6", "fits"],
  ["电梯：三层楼，按哪层去哪层", "fits"],
  ["洗衣机：选三个档位，显示剩余时间", "fits"],
  ["把摄氏度换算成华氏度", "fits"],
  ["记账本：记录每天花了多少钱", "theatre"],
  ["给我做一个待办清单", "theatre"],
  ["做一个聊天室", "theatre"],
  ["扫码点餐的小程序", "theatre"],
  ["把这段文字翻译成英文", "theatre"],
  ["猜数字游戏：我想一个数你来猜大了小了", "fits"],
  ["车位满了就亮红灯，有空位亮绿灯，最多 8 个车位", "fits"],
  ["自动售货机的找零计算", "fits"],
  ["宠物喂食器：按一下出一份，一天最多五份", "fits"],
];

// `restarts` asks again from a blank page and keeps the first answer that compiles and is
// proven on every row - the gate is the compiler, so trying again can only add right answers.
export async function attempt(sentence, via, attempts = 3, restarts = 1) {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  try {
    const accept = (spec) => {
      try {
        compileSpec("expr", spec, { steps: 20_000 });
        return true;
      } catch {
        return false;
      }
    };
    const { spec, question, attempts: tries, restarts: used } = restarts > 1
      ? await askModelBestOf({ ...via, sentence, attempts, restarts, accept })
      : await askModel({ ...via, sentence, attempts });
    if (question) return { result: "asked back", detail: question, seconds: seconds() };
    const program = parseProgram(spec);
    const { certificate } = compileSpec("expr", spec, { steps: 20_000 });
    return {
      result: "built",
      attempts: tries,
      restarts: used ?? 1,
      bits: program.nIn + program.nState,
      nand: certificate.circuit.nand,
      latch: certificate.circuit.latch,
      rows: certificate.verification.rowsChecked,
      outputs: Object.keys(spec.outputs).join(","),
      seconds: seconds(),
    };
  } catch (error) {
    return { result: "failed", detail: error.message, seconds: seconds() };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  takeLock();
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "openai" },
      model: { type: "string" },
      "base-url": { type: "string" },
      repeat: { type: "string", default: "1" },
      restarts: { type: "string", default: "1" },
      all: { type: "boolean", default: false }, // also try the split and theatre ones
      json: { type: "string" },
    },
  });
  const via = {
    provider: values.provider,
    model: values.model,
    baseUrl: values["base-url"],
    key: process.env[PROVIDERS[values.provider]?.keyEnv ?? ""] ?? "",
  };
  const wanted = SENTENCES.filter(([, verdict]) => values.all || verdict === "fits");
  const passes = [];
  for (let pass = 1; pass <= Number(values.repeat); pass += 1) {
    const rows = [];
    for (const [sentence, verdict] of wanted) {
      const outcome = { sentence, verdict, ...(await attempt(sentence, via, 3, Number(values.restarts))) };
      rows.push(outcome);
      console.log(`${pass} ${outcome.result.padEnd(10)} ${sentence}${outcome.detail ? `  — ${outcome.detail.slice(0, 90)}` : ""}`);
    }
    passes.push(rows);
    console.log(`pass ${pass}: ${rows.filter((r) => r.result === "built").length} of ${rows.length} built\n`);
  }
  for (const [sentence] of wanted) {
    const built = passes.filter((rows) => rows.find((r) => r.sentence === sentence)?.result === "built").length;
    console.log(`${built}/${passes.length}  ${sentence}`);
  }
  if (values.json) (await import("node:fs")).writeFileSync(values.json, `${JSON.stringify(passes, null, 1)}\n`);
}
