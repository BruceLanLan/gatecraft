// The sentence tier: the prompt a person pastes into their own model, and reading its reply.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describePrompt, PROMPT_EXAMPLES, specFromReply } from "../src/describe.mjs";
import { parseProgram, programTable } from "../src/expr.mjs";

test("every program the prompt teaches is one the compiler accepts, and means what its sentence says", () => {
  for (const e of PROMPT_EXAMPLES) parseProgram(e.spec);
  const at = (spec, values) => {
    const program = parseProgram(spec);
    let row = 0, shift = 0;
    program.inputs.forEach((input, i) => { row += values[i] * 2 ** shift; shift += input.width; });
    return programTable(program).ys[row];
  };
  const [adder, thermostat, prime] = PROMPT_EXAMPLES.map((e) => e.spec);
  assert.equal(at(adder, [200, 100]), 300);
  assert.equal(at(thermostat, [20, 30, 0]), 1 | (10 << 1));   // cold: heat on, 10 below
  assert.equal(at(thermostat, [30, 29, 1]), 1 | (1 << 1));    // within the band, stays on
  assert.equal(at(thermostat, [32, 30, 1]), 0 | (2 << 1));    // warm: off
  const primes = [2, 3, 5, 7, 11, 13];
  for (let v = 0; v < 16; v++) assert.equal(at(prime, [v]), (primes.includes(v) ? 1 : 0) | ((v >> 2) << 1), `v=${v}`);
});

test("the prompt carries the rules, the examples and the sentence, and needs a sentence", () => {
  const prompt = describePrompt("  a 3-input majority vote  ");
  assert.match(prompt, /20 bits at most/);
  assert.match(prompt, /modulo 2\^width/);
  assert.match(prompt, /Always include 3 to 6 examples/);
  for (const e of PROMPT_EXAMPLES) assert.ok(prompt.includes(e.sentence));
  assert.ok(prompt.endsWith("Behaviour: a 3-input majority vote\nProgram:"));
  assert.throws(() => describePrompt("   "), /sentence/);
});

test("a program is read out of a bare, fenced or chatty reply", () => {
  const spec = { inputs: { a: 1, b: 1, c: 1 }, outputs: { y: { width: 1, expr: "a + b + c >= 2" } } };
  const json = JSON.stringify(spec, null, 2);
  assert.deepEqual(specFromReply(json), spec);
  assert.deepEqual(specFromReply(`Here you go:\n\`\`\`json\n${json}\n\`\`\`\nThe output is 1 when two or more inputs are 1.`), spec);
  assert.deepEqual(specFromReply(`Sure! ${JSON.stringify(spec)} Let me know.`), spec);
  assert.throws(() => specFromReply("I cannot do that."), /no JSON object/);
  assert.throws(() => specFromReply("{ inputs: a }"), /does not parse/);
});

// ---- asking a model with the user's own key, against fake providers (no network)

import { PROVIDERS, askModel, askModelBestOf, checkEndpoint, modelRequest, replyText } from "../src/describe.mjs";

const GOOD = {
  inputs: { a: 1, b: 1, c: 1 },
  outputs: { y: { width: 1, expr: "a + b + c >= 2" } },
  examples: [{ given: { a: 1, b: 1, c: 0 }, expect: { y: 1 } }, { given: { a: 0, b: 0, c: 1 }, expect: { y: 0 } }],
};

function fakeProvider(provider, answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = answers[calls.length - 1];
    const body = provider === "anthropic" ? { content: [{ type: "text", text }] } : { choices: [{ message: { content: text } }] };
    return { status: 200, json: async () => body };
  };
  return { calls, fetch };
}

test("the key goes only to the chosen provider, over https or to this computer", () => {
  const a = modelRequest({ provider: "anthropic", key: " sk-test ", messages: [] });
  assert.equal(a.url, "https://api.anthropic.com/v1/messages");
  assert.equal(a.init.headers["x-api-key"], "sk-test");
  assert.equal(JSON.parse(a.init.body).model, "claude-sonnet-5");
  const o = modelRequest({ provider: "openai", baseUrl: "http://127.0.0.1:11434/v1/", model: "local", key: "k", messages: [] });
  assert.equal(o.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(o.init.headers.authorization, "Bearer k");
  assert.throws(() => checkEndpoint("http://api.example.com/v1"), /https/);
  assert.throws(() => checkEndpoint("https://user:pw@api.example.com"), /key field/);
  assert.throws(() => modelRequest({ provider: "openai", key: "k", messages: [] }), /name the model/);
  assert.throws(() => modelRequest({ provider: "anthropic", key: " ", messages: [] }), /API key/);
  // a model server on this computer needs no key, and gets no authorization header
  const local = modelRequest({ provider: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "m", key: "", messages: [] });
  assert.equal(local.init.headers.authorization, undefined);
  assert.throws(() => modelRequest({ provider: "other", key: "k", messages: [] }), /provider/);
  assert.throws(() => replyText("anthropic", 401, { type: "error", error: { message: "invalid x-api-key" } }), /401: invalid x-api-key/);
  assert.throws(() => replyText("openai", 200, { choices: [] }), /no text/);
});

test("askModel returns a program the compiler accepts, and shows the model its error once", async () => {
  for (const provider of ["anthropic", "openai"]) {
    const ok = fakeProvider(provider, [`\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``]);
    const first = await askModel({ provider, model: "m", key: "k", sentence: "majority of three", fetch: ok.fetch });
    assert.deepEqual(first.spec, GOOD);
    assert.equal(first.attempts, 1);
    assert.match(ok.calls[0].body.messages[0].content, /Behaviour: majority of three\nProgram:$/);

    const bad = { inputs: { a: 1 }, outputs: { y: { width: 1, expr: "a + q" } } };
    const fix = fakeProvider(provider, [JSON.stringify(bad), JSON.stringify(GOOD)]);
    const second = await askModel({ provider, model: "m", key: "k", sentence: "majority", fetch: fix.fetch });
    assert.equal(second.attempts, 2);
    const retry = fix.calls[1].body.messages;
    assert.deepEqual(retry.map((m) => m.role), ["user", "assistant", "user"]);
    assert.match(retry[2].content, /unknown name "q"/);

    // a program that contradicts its own examples, and one with none, are sent back too
    const contradicts = { ...GOOD, outputs: { y: { width: 1, expr: "a + b + c >= 1" } } };
    const noExamples = { inputs: GOOD.inputs, outputs: GOOD.outputs };
    const strict = fakeProvider(provider, [JSON.stringify(contradicts), JSON.stringify(noExamples), JSON.stringify(GOOD)]);
    const third = await askModel({ provider, model: "m", key: "k", sentence: "majority", fetch: strict.fetch, attempts: 3 });
    assert.equal(third.attempts, 3);
    const asked = strict.calls[2].body.messages;
    assert.match(asked[2].content, /disagrees with 1 of its own examples[\s\S]*example 2: given a=0 b=0 c=1, expected y=0 but the program gives y=1/);
    assert.match(asked[4].content, /has no examples/);

    const never = fakeProvider(provider, ["no idea", "still no idea"]);
    await assert.rejects(askModel({ provider, model: "m", key: "k", sentence: "x", fetch: never.fetch }), /after 2 tries: the reply contains no JSON object/);
  }
  const down = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(askModel({ provider: "anthropic", key: "k", sentence: "x", fetch: down }), /could not reach the model provider at https:\/\/api\.anthropic\.com/);
});

// ---- the command line, against a fake OpenAI-compatible server on this computer

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { ROOT, runScript, tempDir } from "./helpers.mjs";

test("describe.mjs writes a checked program with the key from the environment, or prints the prompt", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, url: req.url, model: JSON.parse(body).model });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const dir = tempDir();
    const args = [join(ROOT, "scripts", "describe.mjs"), "majority of three bits", "--name", "maj", "--provider", "openai", "--model", "local", "--base-url", `http://127.0.0.1:${server.address().port}/v1`, "--key-env", "GATECRAFT_TEST_KEY"];
    const child = spawn(process.execPath, args, { cwd: dir, env: { ...process.env, GATECRAFT_TEST_KEY: "sk-env" } });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0, out);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "maj.expr.json"), "utf8")), GOOD);
    assert.deepEqual(seen, [{ auth: "Bearer sk-env", url: "/v1/chat/completions", model: "local" }]);
    assert.match(out, /compile-expr\.mjs --spec maj\.expr\.json --name maj/);
  } finally {
    server.close();
  }
  const noKey = runScript("scripts/describe.mjs", ["x", "--name", "maj", "--key-env", "GATECRAFT_UNSET_KEY"]);
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /set GATECRAFT_UNSET_KEY/);
  const prompt = runScript("scripts/describe.mjs", ["a 3-input majority vote", "--prompt-only"]);
  assert.equal(prompt.status, 0);
  assert.match(prompt.stdout, /Behaviour: a 3-input majority vote\nProgram:/);
});

test("a model may ask one question back instead of guessing, and the page gets the question", async () => {
  const { questionFromReply } = await import("../src/describe.mjs");
  assert.equal(questionFromReply('{"question": "灯是按住才亮，还是按一下切换？"}'), "灯是按住才亮，还是按一下切换？");
  assert.equal(questionFromReply(JSON.stringify(GOOD)), null);
  assert.equal(questionFromReply("no json"), null);
  const asks = fakeProvider("anthropic", ['```json\n{"question": "How many bits is the count?"}\n```']);
  const result = await askModel({ provider: "anthropic", key: "k", sentence: "a counter", fetch: asks.fetch });
  assert.deepEqual([result.question, result.spec, asks.calls.length], ["How many bits is the count?", undefined, 1]);
  assert.match(describePrompt("x"), /reply with \{"question"/);
});

test("providers are a table: two wire shapes, labels in both languages, safe endpoints", async () => {
  const { PROVIDERS, providerStyle } = await import("../src/describe.mjs");
  const ids = Object.keys(PROVIDERS);
  assert.ok(ids.length >= 8, ids.join(", "));
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    assert.match(id, /^[a-z][a-z0-9]*$/);
    assert.ok(provider.label.en && provider.label.zh, `${id}: a label in both languages`);
    assert.ok(["anthropic", "openai"].includes(provider.style), `${id}: ${provider.style}`);
    assert.equal(providerStyle(id), provider.style);
    assert.ok(["yes", "unknown", "no"].includes(provider.browser), `${id}: browser ${provider.browser}`);
    assert.doesNotThrow(() => checkEndpoint(provider.baseUrl), `${id}: ${provider.baseUrl}`);
    if (!provider.local) assert.match(provider.baseUrl, /^https:\/\//, `${id} must be https`);
    assert.ok(typeof provider.model === "string");
    // a provider without a default model asks for one instead of inventing it
    if (!provider.model) assert.throws(() => modelRequest({ provider: id, key: "k", messages: [] }), /name the model/, id);
  }
  // every OpenAI-shaped provider builds the same request shape
  const shapes = ids.filter((id) => PROVIDERS[id].style === "openai").map((id) => modelRequest({ provider: id, model: "m", key: "k", messages: [] }));
  assert.ok(shapes.every((r) => r.url.endsWith("/chat/completions")));
  assert.equal(modelRequest({ provider: "anthropic", model: "m", key: "k", messages: [] }).url.endsWith("/messages"), true);
});

test("asking again from a blank page keeps the first answer that gets through", async () => {
  // Two drafts that fail their own examples, then one that holds: the caller sees only the
  // good one, and is told how many tries it took.
  const bad = JSON.stringify({ inputs: { a: 1 }, outputs: { y: { width: 1, expr: "a" } }, examples: [{ given: { a: 1 }, expect: { y: 0 } }] });
  const good = JSON.stringify({ inputs: { a: 1 }, outputs: { y: { width: 1, expr: "a" } }, examples: [{ given: { a: 1 }, expect: { y: 1 } }, { given: { a: 0 }, expect: { y: 0 } }] });
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: calls <= 4 ? bad : good } }] }) };
  };
  const out = await askModelBestOf({ provider: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "m", key: "k", sentence: "一个灯", attempts: 2, restarts: 5, fetch });
  assert.equal(out.restarts, 3, "the third fresh try is the one that held");
  assert.deepEqual(Object.keys(out.spec.outputs), ["y"]);

  // accept() is the caller's own gate: refusing everything must not smuggle a program through.
  await assert.rejects(
    askModelBestOf({ provider: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "m", key: "k", sentence: "一个灯", attempts: 1, restarts: 2, fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: good } }] }) }), accept: () => false }),
    /compiler would not take it/,
  );

  // A question is the right answer to a vague sentence, so it survives the restarts.
  const asks = await askModelBestOf({
    provider: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "m", key: "k", sentence: "帮我做个东西", attempts: 1, restarts: 3,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ question: "你要它数什么？" }) } }] }) }),
  });
  assert.equal(asks.question, "你要它数什么？");
});

test("a provider that routes by a session header gets one, and the others do not", () => {
  const { init } = modelRequest({ provider: "opencode", model: "qwen3.7-max", key: "k", messages: [], session: "run-7" });
  assert.equal(init.headers["x-opencode-session"], "run-7");
  assert.equal(init.headers.authorization, "Bearer k");
  assert.equal(modelRequest({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "m", key: "k", messages: [] }).init.headers["x-opencode-session"], undefined);
  assert.equal(PROVIDERS.opencode.baseUrl, "https://opencode.ai/zen/go/v1");
});
