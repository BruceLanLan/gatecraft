#!/usr/bin/env node
// Sentence-tier check against a real model: each everyday sentence goes through askModel's own
// loop (examples, retries), and the program that comes back is compared on every row with a
// hand-written answer, matching inputs and outputs by the order the sentence names them.
//
//   node tools/nl-eval.mjs --cmd grok --arg=-p                 a CLI that takes the prompt as its last argument
//   ANTHROPIC_API_KEY=... node tools/nl-eval.mjs --provider anthropic
//
// Run it before and after changing the prompt in src/describe.mjs. It spends model calls on
// the caller's own account.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { askModel, PROVIDERS } from "../src/describe.mjs";
import { createRng } from "../src/rng.mjs";
import { parseProgram, runProgram, runStep } from "../src/expr.mjs";
import { compileSpec } from "../src/job.mjs";

const popcount = (v) => v.toString(2).split("").filter((c) => c === "1").length;
export const CASES = [
  { s: "两个 4 位数，输出较大的那个，以及它们是否相等", f: ([a, b]) => [Math.max(a, b), +(a === b)] },
  { s: "三个人投票，每人一位，1 表示同意，多数同意就通过", f: ([a, b, c]) => [+(a + b + c >= 2)] },
  { s: "一个 8 位数，数一数里面有几个 1", f: ([v]) => [popcount(v)] },
  { s: "考试分数用 7 位表示，60 分及以上算及格，90 分及以上算优秀，分别输出及格和优秀", f: ([v]) => [+(v >= 60), +(v >= 90)] },
  { s: "红绿灯：输入当前灯（2 位，0 红、1 绿、2 黄），输出下一个灯：红变绿，绿变黄，黄变红", f: ([v]) => (v === 3 ? null : [[1, 2, 0][v]]) },
  { s: "一个 6 位数，拆成十位数字和个位数字输出", f: ([v]) => [Math.floor(v / 10), v % 10] },
  { s: "两个 5 位数相乘", f: ([a, b]) => [a * b] },
  { s: "一个 4 位数，是 3 的倍数时灯亮", f: ([v]) => [+(v % 3 === 0)] },
  // harder: no single operator does it, or the words carry a rounding rule
  { s: "一个 8 位数的平方根，向下取整", f: ([v]) => [Math.floor(Math.sqrt(v))] },
  { s: "两个 8 位数的平均数，四舍五入", f: ([a, b]) => [Math.floor((a + b + 1) / 2)] },
  { s: "一个 6 位二进制数，把它的位顺序倒过来", f: ([v]) => [parseInt(v.toString(2).padStart(6, "0").split("").reverse().join(""), 2)] },
  { s: "一个 12 位数，是不是 7 的倍数", f: ([v]) => [+(v % 7 === 0)] },
  // vague: no widths given
  { s: "两个数谁大就输出谁", f: ([a, b]) => [Math.max(a, b)] },
  { s: "温度超过 30 度就开风扇", f: ([t]) => [+(t > 30)] },
  // memory: checked by running random input sequences from power-on. An output may show the
  // state before the tick (it changes one tick after the input) or already include the current
  // input; both readings of everyday words are accepted, each must hold for the whole run.
  { s: "一个按钮计数器：每按一下加 1，数到 9 之后再按就回到 0，输出当前的数", seq: (presses) => presses.map((_, k) => presses.slice(0, k).reduce((n, p) => n + p, 0) % 10), inputs: 1 },
  { s: "一个开关灯：按一下亮，再按一下灭", seq: (presses) => presses.map((_, k) => presses.slice(0, k).reduce((n, p) => n + p, 0) % 2), inputs: 1 },
  { s: "连续收到三个 1 就报警，中间收到 0 就重新数", seq: (bits) => bits.map((_, k) => { let run = 0; for (let i = 0; i < k; i++) run = bits[i] ? run + 1 : 0; return +(run >= 3); }), inputs: 1 },
  // too vague to build: the model should ask rather than guess
  { s: "帮我做一个灯", expectQuestion: true },
  // repair: the first answer is a wrong program whose examples follow the sentence; the model
  // sees which examples fail and must fix it
  {
    s: "两个 4 位数，输出较大的那个", f: ([a, b]) => [Math.max(a, b)],
    firstReply: JSON.stringify({ inputs: { a: 4, b: 4 }, outputs: { larger: { width: 4, expr: "a < b ? a : b" } }, examples: [{ given: { a: 3, b: 9 }, expect: { larger: 9 } }, { given: { a: 7, b: 2 }, expect: { larger: 7 } }] }),
  },
];

// A stateful program against a sequence oracle: the "before" reading uses the outputs as they
// are; the "after" reading compares with the oracle shifted by one input.
export function scoreSequence(spec, c) {
  const p = parseProgram(spec);
  if (p.inputs.length !== c.inputs || p.outputs.length !== 1) return { checked: 0, wrong: 1, first: { shape: "inputs or outputs do not match the sentence" } };
  const rng = createRng(12345);
  let wrong = 0, checked = 0, first = null;
  for (let run = 0; run < 20; run++) {
    const values = Array.from({ length: 40 }, () => (rng() < 0.6 ? 1 : 0));
    let state = Object.fromEntries(p.states.map((st) => [st.name, 0]));
    const got = [];
    for (const v of values) {
      const r = runStep(p, { [p.inputs[0].name]: v, ...state });
      got.push(r.outputs[p.outputs[0].name]);
      state = r.next;
    }
    const before = c.seq(values);
    const after = c.seq([...values, 0]).slice(1);
    const same = (want) => want.every((w, k) => w === got[k]);
    checked++;
    if (!same(before) && !same(after)) { wrong++; first ??= { values: values.join(""), got: got.join(""), want: before.join("") }; }
  }
  return { checked, wrong, first };
}

export function score(spec, f) {
  const p = parseProgram(spec);
  let wrong = 0, checked = 0, first = null;
  for (let row = 0; row < 2 ** p.nIn; row++) {
    let shift = 0;
    const values = [], given = {};
    for (const i of p.inputs) { const v = Math.floor(row / 2 ** shift) % 2 ** i.width; given[i.name] = v; values.push(v); shift += i.width; }
    const want = f(values);
    if (!want) continue;
    const got = runProgram(p, given);
    const list = p.outputs.map((o) => got[o.name]);
    checked++;
    if (want.length !== list.length || want.some((w, k) => w !== list[k])) { wrong++; first ??= { given, want, got: list }; }
  }
  return { checked, wrong, first };
}

// A command-line model as a provider: the conversation flattened into one prompt.
const commandFetch = (cmd, args) => {
  const cwd = mkdtempSync(join(tmpdir(), "gatecraft-nl-"));
  return async (url, init) => {
    const { messages } = JSON.parse(init.body);
    const text = messages.map((m) => (m.role === "user" ? m.content : `[Your previous answer]\n${m.content}`)).join("\n\n");
    const r = spawnSync(cmd, [...args, text], { cwd, encoding: "utf8", timeout: 300_000 });
    if (r.status !== 0) return { status: 502, json: async () => ({ error: { message: `${cmd} exited ${r.status}: ${r.stderr.slice(0, 200)}` } }) };
    return { status: 200, json: async () => ({ choices: [{ message: { content: r.stdout } }] }) };
  };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { cmd: { type: "string" }, arg: { type: "string", multiple: true, default: [] }, provider: { type: "string" }, model: { type: "string" }, "base-url": { type: "string" } } });
  const via = values.cmd
    ? { provider: "openai", model: "cli", key: "cli", fetch: commandFetch(values.cmd, values.arg) }
    : { provider: values.provider, model: values.model, baseUrl: values["base-url"], key: process.env[PROVIDERS[values.provider]?.keyEnv ?? ""] };
  let exact = 0;
  for (const c of CASES) {
    try {
      let fetch = via.fetch;
      if (c.firstReply && fetch) {
        let used = false;
        const real = fetch;
        fetch = async (url, init) => {
          if (used) return real(url, init);
          used = true;
          return { status: 200, json: async () => ({ choices: [{ message: { content: c.firstReply } }] }) };
        };
      }
      const { spec, attempts, question } = await askModel({ ...via, fetch, sentence: c.s, attempts: 3 });
      if (question || c.expectQuestion) {
        const right = Boolean(question) === Boolean(c.expectQuestion);
        if (right) exact++;
        console.log(`${right ? "exact" : "WRONG"}  ${question ? `asked: ${question}` : `built without asking: ${JSON.stringify(spec?.outputs)}`}  ${c.s}`);
        continue;
      }
      const r = c.seq ? scoreSequence(spec, c) : score(spec, c.f);
      // and all the way to a circuit, proven on every row by the compiler itself
      const { certificate } = compileSpec("expr", spec, { steps: 20_000 });
      if (r.wrong === 0 && certificate.verification.wrong === 0) exact++;
      const circuit = `${certificate.circuit.nand} NAND from ${certificate.synthesis.frontEnd ?? "bdd"}`;
      console.log(`${r.wrong === 0 ? "exact" : `WRONG ${r.wrong}/${r.checked}`}  tries ${attempts}  ${circuit}  ${c.s}${r.first ? `  e.g. ${JSON.stringify(r.first)}` : ""}`);
      console.log(`    ${JSON.stringify(spec.outputs)}`);
    } catch (error) {
      console.log(`FAILED  ${c.s}: ${error.message.slice(0, 200)}`);
    }
  }
  console.log(`${exact}/${CASES.length} sentences handled as intended (a circuit with exactly the intended behaviour, or a question when too vague)`);
}
