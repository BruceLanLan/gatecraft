// A sentence to an expression program, through a language model the user runs and pays for.
//
// gatecraft pays for no model. Two ways in, both on the user's own account:
//   - describePrompt() writes the text a person pastes into whatever assistant they already
//     use, and specFromReply() reads the program back out of the answer;
//   - askModel() sends the same prompt with the user's own API key straight to the provider
//     they chose, and nowhere else. The key is only ever a request header to that provider.
// The compile that follows is proven on every row as usual - but what it proves is that the
// circuit matches the program, not that the program matches the sentence. The person checks
// the program; the page shows it to them.
import { describeFailure, exampleFailures, MAX_INPUT_BITS, MAX_OUTPUT_BITS, parseProgram } from "./expr.mjs";

// Worked examples inside the prompt. tests/describe.test.mjs compiles every one of them, so
// the prompt never teaches the model a program the compiler would reject.
export const PROMPT_EXAMPLES = [
  {
    sentence: "Add two 8-bit numbers and give the 9-bit sum.",
    spec: {
      inputs: { a: 8, b: 8 },
      outputs: { sum: { width: 9, expr: "a + b" } },
      examples: [
        { given: { a: 3, b: 4 }, expect: { sum: 7 } },
        { given: { a: 255, b: 255 }, expect: { sum: 510 } },
        { given: { a: 0, b: 0 }, expect: { sum: 0 } },
      ],
    },
  },
  {
    sentence: "A thermostat: 7-bit temperature and target, and whether the heater is on now. Turn the heater on when it is more than 2 below target, keep it on until it is more than 1 above, and also output how far the temperature is from target.",
    spec: {
      inputs: { temp: 7, target: 7, heating: 1 },
      let: { cold: "temp + 2 < target", warm: "temp > target + 1" },
      outputs: {
        heat: { width: 1, expr: "cold || (heating && !warm)" },
        error: { width: 7, expr: "temp > target ? temp - target : target - temp" },
      },
      examples: [
        { given: { temp: 18, target: 22, heating: 0 }, expect: { heat: 1, error: 4 } },
        { given: { temp: 22, target: 22, heating: 1 }, expect: { heat: 1, error: 0 } },
        { given: { temp: 24, target: 22, heating: 1 }, expect: { heat: 0, error: 2 } },
        { given: { temp: 21, target: 22, heating: 0 }, expect: { heat: 0, error: 1 } },
      ],
    },
  },
  {
    sentence: "Given a 4-bit value, say whether it is a prime number and output its top two bits.",
    spec: {
      inputs: { v: 4 },
      outputs: {
        prime: { width: 1, expr: "v == 2 || v == 3 || v == 5 || v == 7 || v == 11 || v == 13" },
        top: { width: 2, expr: "v[3:2]" },
      },
      examples: [
        { given: { v: 7 }, expect: { prime: 1, top: 1 } },
        { given: { v: 9 }, expect: { prime: 0, top: 2 } },
        { given: { v: 2 }, expect: { prime: 1, top: 0 } },
        { given: { v: 1 }, expect: { prime: 0, top: 0 } },
      ],
    },
  },
  {
    sentence: "A button counter shown on one digit: each press adds 1, after 9 it goes back to 0, and a light shows when it reads 9.",
    spec: {
      inputs: { press: 1 },
      state: { count: { width: 4, next: "press ? (count == 9 ? 0 : count + 1) : count" } },
      outputs: { digit: { width: 4, expr: "count" }, nine: { width: 1, expr: "count == 9" } },
      examples: [
        { given: { press: 1, count: 0 }, expect: { digit: 0, nine: 0 }, then: { count: 1 } },
        { given: { press: 0, count: 5 }, expect: { digit: 5 }, then: { count: 5 } },
        { given: { press: 1, count: 9 }, expect: { digit: 9, nine: 1 }, then: { count: 0 } },
      ],
    },
  },
];

export function describePrompt(sentence) {
  const text = String(sentence ?? "").trim();
  if (!text) throw new Error("describe the behaviour in a sentence first");
  const examples = PROMPT_EXAMPLES.map((e) => `Behaviour: ${e.sentence}\nProgram:\n${JSON.stringify(e.spec, null, 2)}`).join("\n\n");
  return `You translate a behaviour described in words into a small combinational circuit program for the gatecraft compiler. Reply with the JSON program only.

Format:
{
  "inputs":  { "<name>": <bits>, ... },             in order; all inputs together ${MAX_INPUT_BITS} bits at most
  "state":   { "<name>": { "width": <bits>, "next": "<expression>" }, ... },  optional memory, see below
  "let":     { "<name>": "<expression>", ... },     optional shared definitions, in order
  "outputs": { "<name>": { "width": <bits>, "expr": "<expression>" }, ... },  together ${MAX_OUTPUT_BITS} bits at most
  "examples": [ { "given": { "<every input>": <value>, "<state>": <value> }, "expect": { "<output>": <value> }, "then": { "<state>": <value after the tick> } }, ... ]
}

Rules:
- Names are identifiers (letters, digits, _), each used once across inputs, state, "let" and outputs together: a stored count is "count" in state and "digit" in outputs.
- A value of n bits holds 0 .. 2^n - 1, and every number in an example must fit: counting to 5 needs 3 bits.
- Inputs and state together stay within 20 bits, so pick the smallest widths that work. If even that does not fit, cover the part that does and say what you left out.
- Values are exact integers. Each output is its value modulo 2^width, so choose widths that hold the results you want; a negative result wraps like two's complement.
- Operators and precedence are JavaScript's: ?: || && | ^ & == != < <= > >= << >> >>> + - * / % and unary ~ ! -. Bit slices: v[3], v[7:4]. Literals: 12, 0xff, 0b1010.
- Comparisons and ! && || give 0 or 1; any non-zero value counts as true.
- / and % need a dividend that cannot be negative and a divisor that is always at least 1. Shift amounts cannot be negative.
- Memory: when the behaviour has to remember something between clock ticks (counts, modes, "until", "after N times"), declare it in "state". A state value is 0 at power-on and becomes its "next" expression after every tick; outputs and "next" read the current value. Without state, outputs depend only on the current inputs. Inputs and state together are ${MAX_INPUT_BITS} bits at most.
- A timer or duration becomes a count of clock ticks; say so in the names (e.g. ticks_left).
- Always include 3 to 6 examples, worked out from the words, not from your expressions: every example the person gave, then ones for the ordinary case and the edges (zero, largest values, ties). Each example must give every input; with state, give the current state too and put the state after the tick in "then". The program is checked against them before it is compiled, so they catch a program that does not do what was asked.
- No loops, functions or other syntax. If the words leave a size or a detail open, pick the smallest reasonable choice.
- Only when the words could mean clearly different behaviours and no reasonable default exists, do not guess: reply with {"question": "<one short question, in the language of the description>"} instead of a program.

${examples}

Behaviour: ${text}
Program:`;
}

// The program in a model's reply: a bare JSON object, or one inside a code fence or prose.
// A clarifying question instead of a program: { "question": "..." }, or null.
export function questionFromReply(reply) {
  try {
    const obj = specFromReply(reply);
    return typeof obj.question === "string" && obj.question.trim() && !obj.outputs ? obj.question.trim() : null;
  } catch {
    return null;
  }
}

export function specFromReply(reply) {
  const text = String(reply ?? "");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the reply contains no JSON object");
  let spec;
  try {
    spec = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new Error(`the reply's JSON does not parse: ${error.message}`);
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("the reply's JSON is not an object");
  return spec;
}

// ---- a model already running on this computer

// Where a local model server usually listens, with an OpenAI-compatible API. Probing these
// needs no key: the page asks each one for its model list and uses the first that answers.
export const LOCAL_ENDPOINTS = [
  { name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
];

// The models one endpoint offers, newest-looking first is not our business: the order is the
// server's own. Returns [] when nothing answers.
export async function listLocalModels(baseUrl, { fetch = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const base = checkEndpoint(baseUrl);
  let response;
  try {
    response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let body = null;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return rows.map((row) => (typeof row === "string" ? row : row?.id ?? row?.name)).filter((id) => typeof id === "string" && id);
}

// The first local server that answers, with the models it offers, or null.
export async function findLocalModel({ endpoints = LOCAL_ENDPOINTS, fetch = globalThis.fetch, timeoutMs = 1500 } = {}) {
  for (const endpoint of endpoints) {
    const models = await listLocalModels(endpoint.baseUrl, { fetch, timeoutMs });
    if (models.length) return { ...endpoint, models, model: models[0], provider: "openai" };
  }
  return null;
}

// ---- asking a model directly, with the user's key

// Who can be asked. Two wire styles cover the field: Anthropic's own, and the OpenAI-shaped
// one that nearly everyone else answers - which is why adding a provider is a row here, not
// code. A provider whose model name is empty asks for one, rather than inventing a default
// that may not exist. `browser` says whether that endpoint has been seen to accept a request
// straight from a page: "yes" was watched happen, "unknown" means nobody has tried here, and
// an endpoint that refuses one is still usable through the copied prompt.
export const PROVIDERS = {
  anthropic: { label: { en: "Anthropic (Claude)", zh: "Anthropic（Claude）" }, style: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5", keyEnv: "ANTHROPIC_API_KEY", browser: "yes" },
  openai: { label: { en: "OpenAI-compatible", zh: "OpenAI 兼容接口" }, style: "openai", baseUrl: "https://api.openai.com/v1", model: "", keyEnv: "OPENAI_API_KEY", browser: "yes" },
  deepseek: { label: { en: "DeepSeek", zh: "DeepSeek" }, style: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyEnv: "DEEPSEEK_API_KEY", browser: "yes" },
  moonshot: { label: { en: "Moonshot (Kimi)", zh: "月之暗面（Kimi）" }, style: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "", keyEnv: "MOONSHOT_API_KEY", browser: "yes" },
  zhipu: { label: { en: "Zhipu (GLM)", zh: "智谱（GLM）" }, style: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "", keyEnv: "ZHIPU_API_KEY", browser: "yes" },
  dashscope: { label: { en: "Alibaba (Qwen)", zh: "阿里云百炼（通义千问）" }, style: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "", keyEnv: "DASHSCOPE_API_KEY", browser: "unknown" },
  groq: { label: { en: "Groq", zh: "Groq" }, style: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "", keyEnv: "GROQ_API_KEY", browser: "yes" },
  openrouter: { label: { en: "OpenRouter", zh: "OpenRouter" }, style: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "", keyEnv: "OPENROUTER_API_KEY", browser: "yes" },
  // OpenCode Go is OpenAI-shaped but routes by a session header, and refuses the request
  // without one. The value only has to be stable for a run, not secret.
  opencode: { label: { en: "OpenCode Go", zh: "OpenCode Go" }, style: "openai", baseUrl: "https://opencode.ai/zen/go/v1", model: "", keyEnv: "OPENCODE_API_KEY", browser: "unknown", headers: (session) => ({ "x-opencode-session": session }) },
  local: { label: { en: "A model on this computer", zh: "这台电脑上的模型" }, style: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "", keyEnv: "", browser: "yes", local: true },
};

// Everything that is not Anthropic's own wire format speaks the OpenAI shape.
export const providerStyle = (id) => (PROVIDERS[id]?.style ?? "openai");
// Generous on purpose. A model that thinks before it answers can spend tens of thousands of
// characters doing it, and a tight cap does not save money - you pay for what is generated -
// it just truncates the answer and looks like the model failed.
const MAX_TOKENS = 16_000;

// A key goes over TLS, or to this computer (a local model server); never in clear to anywhere else.
export function checkEndpoint(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`the API address ${JSON.stringify(baseUrl)} is not a URL`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("the API address must use https:// (plain http:// only for a model server on this computer)");
  }
  if (url.username || url.password) throw new Error("put the key in the key field, not in the API address");
  return url.href.replace(/\/+$/, "");
}

// The HTTP request for one conversation. `messages` alternate user and assistant.
export function modelRequest({ provider, baseUrl, model, key, messages, session = "gatecraft" }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  const base = checkEndpoint(baseUrl || p.baseUrl);
  const name = String(model || p.model).trim();
  if (!name) throw new Error("name the model to use");
  const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(`${base}/`);
  if ((!key || !String(key).trim()) && !local) throw new Error("an API key is needed; it is sent only to the provider");
  if (p.style === "anthropic") {
    return {
      url: `${base}/messages`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": String(key).trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: name, max_tokens: MAX_TOKENS, messages }),
      },
    };
  }
  return {
    url: `${base}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key && String(key).trim() ? { authorization: `Bearer ${String(key).trim()}` } : {}),
        ...(p.headers ? p.headers(session) : {}),
      },
      body: JSON.stringify({ model: name, messages }),
    },
  };
}

// The text of a provider's answer, or the provider's own error message.
export function replyText(provider, status, body) {
  const message = body?.error?.message ?? (typeof body?.error === "string" ? body.error : null);
  if (status < 200 || status >= 300 || message) throw new Error(`the model provider answered ${status}${message ? `: ${message}` : ""}`);
  const text = providerStyle(provider) === "anthropic"
    ? (body?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("")
    : body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("the model provider's answer has no text");
  return text;
}

// Ask again from a blank page, as many times as it takes, and keep the first answer that
// gets through. This is worth more than any amount of rewording: the filter in front of it is
// sound - a program only counts once it agrees with its own examples and, if the caller says
// so through `accept`, once the compiler has proved it on every row - so trying again can add
// nothing wrong, only more chances to be right. On this machine's small model, the ten
// sentences that fit built 3.5 of ten on one try and, by their own per-sentence rates over
// eleven rounds, should build about 7.4 of ten given five.
//
// A restart starts a NEW conversation. Repairing inside one conversation is what `attempts`
// does, and the two are different things: the literature finds fresh drafts beat deeper
// self-repair for small models, though our repair sees the exact failing example rather than
// the model's own guess at what went wrong, so the two are measured against each other rather
// than assumed.
//
// A question is not a failure - it is the right answer to a vague sentence - so it is
// remembered and returned if nothing else gets through, rather than being restarted past.
export async function askModelBestOf({ restarts = 1, accept, onRestart, ...options }) {
  let question = null;
  let lastError = null;
  for (let restart = 1; restart <= restarts; restart++) {
    onRestart?.(restart);
    try {
      const out = await askModel(options);
      if (out.question) {
        question ??= { ...out, restarts: restart };
        continue;
      }
      if (!accept || (await accept(out.spec))) return { ...out, restarts: restart };
      lastError = new Error("the program held together but the compiler would not take it");
    } catch (error) {
      lastError = error;
    }
  }
  if (question) return question;
  throw lastError ?? new Error("no attempt produced a usable program");
}

// Ask for a program; if the answer is not a program the compiler accepts, show the model the
// error and ask again, up to `attempts` times. Returns { spec }, or { question } when the model
// needs the person to say more; the person then adds to the sentence and asks again.
export async function askModel({ provider, baseUrl, model, key, sentence, attempts = 2, fetch = globalThis.fetch, timeoutMs = 120_000, onAttempt }) {
  const messages = [{ role: "user", content: describePrompt(sentence) }];
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    onAttempt?.(attempt);
    const { url, init } = modelRequest({ provider, baseUrl, model, key, messages });
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`could not reach the model provider at ${new URL(url).origin} (${error.name === "TimeoutError" ? "timed out" : error.message}); if this is in the browser, the provider may not accept browser requests`);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      // an error page: status alone says enough
    }
    const text = replyText(provider, response.status, body);
    messages.push({ role: "assistant", content: text });
    const question = questionFromReply(text);
    if (question) return { question, attempts: attempt, reply: text };
    try {
      const spec = specFromReply(text);
      const program = parseProgram(spec);
      if (program.examples.length === 0) throw new Error("the program has no examples; add 3 to 6 worked out from the description");
      const failures = exampleFailures(program);
      if (failures.length) {
        throw new Error(`the program disagrees with ${failures.length} of its own examples. Decide from the description which is right, fix that one, and keep them consistent:\n${failures.map(describeFailure).join("\n")}`);
      }
      return { spec, attempts: attempt, reply: text };
    } catch (error) {
      lastError = error;
      messages.push({ role: "user", content: `That program is not accepted: ${error.message}\nReply with the corrected JSON program only.` });
    }
  }
  throw new Error(`the model did not produce a usable program after ${attempts} tries: ${lastError.message}`);
}
