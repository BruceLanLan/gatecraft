// The local API: one POST endpoint, dotted method names, and the same fence the page has —
// loopback only, a checked Host header, no cross-site Origin, and an optional token.
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { MAX_STEPS, METHODS, handleApi } from "../src/api.mjs";
import { startUiServer } from "../src/ui-server.mjs";
import { FAKE, startFakeChain } from "./fake-chain.mjs";

const VOTE = {
  inputs: { a: 1, b: 1, c: 1 },
  outputs: { pass: { width: 1, expr: "a + b + c >= 2" } },
  examples: [{ given: { a: 1, b: 1, c: 0 }, expect: { pass: 1 } }, { given: { a: 1, b: 0, c: 0 }, expect: { pass: 0 } }],
};
const COUNTER = {
  inputs: { press: 1 },
  state: { count: { width: 4, next: "press ? (count == 9 ? 0 : count + 1) : count" } },
  outputs: { digit: { width: 4, expr: "count" } },
  examples: [{ given: { press: 1, count: 9 }, then: { count: 0 } }],
};

function call(port, body, { method = "POST", headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const text = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/api",
      method,
      headers: { host: host ?? `127.0.0.1:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers },
    }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { out += chunk; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(out);
        } catch {
          // a plain-text refusal
        }
        resolve({ status: res.statusCode, type: res.headers["content-type"], body: parsed, text: out });
      });
    });
    req.on("error", reject);
    req.end(method === "GET" || method === "HEAD" ? undefined : text);
  });
}

async function withServer(options, body) {
  const server = await startUiServer({ port: 0, ...options });
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

test("the API compiles a program, proves it, and hands back the same three files", async () => {
  await withServer({}, async ({ port, api }) => {
    assert.match(api, /^http:\/\/127\.0\.0\.1:\d+\/api$/);
    const listed = await call(port, undefined, { method: "GET" });
    assert.equal(listed.status, 200);
    assert.deepEqual([listed.body.result.holdsKeys, listed.body.result.signsTransactions], [false, false]);
    assert.ok(listed.body.result.methods.includes("compile.expr"));

    const r = await call(port, { method: "compile.expr", params: { spec: VOTE, name: "vote", files: true, table: true }, id: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 7);
    const { circuit, certificate, files, table } = r.body.result;
    assert.equal(certificate.verification.wrong, 0);
    assert.equal(certificate.expression.examplesHold, 2);
    assert.equal(circuit.nand, 6);
    assert.equal(table.nIn, 3);
    assert.deepEqual(Object.keys(files), ["circuit.netlist.json", "circuit.certificate.json", "table.json", "circuit.blif", "circuit.firsto.json", "app.html"]);
    assert.equal(JSON.parse(files["circuit.netlist.json"]).netlistHex, circuit.netlistHex);

    // the netlist bytes, run through the API: majority of three
    for (const [inputs, want] of [[[1, 1, 0], 1], [[1, 0, 0], 0], [[0, 1, 1], 1]]) {
      const sim = await call(port, { method: "circuit.simulate", params: { netlistHex: circuit.netlistHex, nIn: 3, nOut: 1, inputs } });
      assert.deepEqual(sim.body.result.outputs, [want], JSON.stringify(inputs));
      assert.equal(sim.body.result.nand, 6);
    }
  });
});

test("the API reports a program's widths, examples and read-back without compiling", async () => {
  await withServer({}, async ({ port }) => {
    const r = await call(port, { method: "program.check", params: { spec: COUNTER } });
    const c = r.body.result;
    assert.deepEqual([c.nIn, c.nState, c.nOut, c.rows], [1, 4, 4, 32]);
    assert.deepEqual(c.state, [{ name: "count", width: 4 }]);
    assert.deepEqual(c.examples, { total: 1, hold: 1, failures: [] });
    assert.match(c.explain.lines.at(-1), /^after each tick, count becomes/);

    const wrong = await call(port, { method: "program.check", params: { spec: { ...COUNTER, examples: [{ given: { press: 1, count: 3 }, then: { count: 5 } }] } } });
    assert.equal(wrong.body.result.examples.hold, 0);
    assert.match(wrong.body.result.examples.failures[0].message, /expected next count=5 but the program gives next count=4/);

    const step = await call(port, { method: "program.run", params: { spec: COUNTER, given: { press: 1, count: 9 } } });
    assert.deepEqual(step.body.result, { outputs: { digit: 9 }, next: { count: 0 } });
    const rows = await call(port, { method: "program.table", params: { spec: VOTE } });
    assert.deepEqual(rows.body.result.ys, [0, 0, 0, 1, 0, 1, 1, 1]);
  });
});

test("the API writes the prompt and reads a model's answer back, holding no key", async () => {
  await withServer({}, async ({ port }) => {
    const prompt = await call(port, { method: "describe.prompt", params: { sentence: "three people vote, most wins" } });
    assert.match(prompt.body.result.prompt, /Behaviour: three people vote, most wins\nProgram:$/);
    // many providers, two wire shapes; a row is all it takes to add one
    assert.ok(prompt.body.result.providers.length >= 8, prompt.body.result.providers.join(", "));
    assert.ok(["anthropic", "openai", "deepseek", "local"].every((id) => prompt.body.result.providers.includes(id)));

    const read = await call(port, { method: "describe.read", params: { reply: `Sure:\n\`\`\`json\n${JSON.stringify(VOTE)}\n\`\`\`` } });
    assert.deepEqual(read.body.result.spec, VOTE);
    assert.deepEqual(read.body.result.examples, { total: 2, hold: 2, failures: [] });

    const asks = await call(port, { method: "describe.read", params: { reply: '{"question": "how many bits?"}' } });
    assert.deepEqual(asks.body.result, { question: "how many bits?" });
    const junk = await call(port, { method: "describe.read", params: { reply: "I cannot" } });
    assert.equal(junk.status, 422);
    assert.equal(junk.body.error.code, "failed");
  });
});

test("tapeout.plan reads the chain the caller names and returns unsigned transactions", async () => {
  const chain = await startFakeChain({});
  try {
    await withServer({}, async ({ port }) => {
      const compiled = await call(port, { method: "compile.expr", params: { spec: VOTE, name: "vote", steps: 2000 } });
      const r = await call(port, { method: "tapeout.plan", params: { netlist: compiled.body.result.circuit, rpc: chain.url, processor: FAKE.processor, from: FAKE.sender, chainId: 56 } });
      assert.equal(r.status, 200);
      assert.equal(r.body.result.signed, false);
      assert.ok(r.body.result.plan.transactions.every((tx) => !("signature" in tx)));
      assert.equal(r.body.result.simulation.ok, true);
      assert.equal(chain.calls.some((m) => /^eth_send/.test(m)), false);

      const badRpc = await call(port, { method: "tapeout.plan", params: { netlist: compiled.body.result.circuit, rpc: "ftp://nope", processor: FAKE.processor, from: FAKE.sender } });
      assert.equal(badRpc.status, 400);
      assert.match(badRpc.body.error.message, /http:\/\/ or https:\/\//);
    });
  } finally {
    await chain.close();
  }
});

test("the API refuses what it should: unknown methods, bad params, other hosts and origins, big bodies", async () => {
  await withServer({}, async ({ port }) => {
    const unknown = await call(port, { method: "compile.everything" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "unknown_method");

    for (const [params, pattern] of [
      [{ spec: VOTE, steps: MAX_STEPS + 1 }, /1\.\.5000000/],
      [{ spec: VOTE, name: "Not A Slug" }, /lowercase slug/],
      [{ spec: VOTE, objective: "speed" }, /gates, cost/],
      [{ spec: "nope" }, /"spec" must be an object/],
    ]) {
      const r = await call(port, { method: "compile.expr", params });
      assert.equal(r.status, 400, JSON.stringify(params));
      assert.match(r.body.error.message, pattern);
    }
    const inexact = await call(port, { method: "compile.expr", params: { spec: { ...VOTE, examples: [{ given: { a: 0, b: 0, c: 0 }, expect: { pass: 1 } }] } } });
    assert.equal(inexact.status, 422);
    assert.match(inexact.body.error.message, /examples do not hold/);

    assert.equal((await call(port, { method: "health.status" }, { host: "attacker.example" })).status, 403);
    const crossOrigin = await call(port, { method: "health.status" }, { headers: { origin: "https://evil.example" } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.body.error.code, "forbidden_origin");
    assert.equal((await call(port, { method: "health.status" }, { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
    assert.equal((await call(port, "", { method: "PUT" })).status, 405);
    assert.equal((await call(port, "not json")).status, 400);
    assert.equal((await call(port, { method: 42 })).status, 404);
    assert.equal((await call(port, JSON.stringify({ method: "health.status", pad: "x".repeat(5 * 1024 * 1024) }))).status, 413);
  });
});

test("a token, when the server is started with one, is required; --no-api serves the page only", async () => {
  await withServer({ apiToken: "s3cret" }, async ({ port }) => {
    assert.equal((await call(port, { method: "health.status" })).status, 401);
    assert.equal((await call(port, { method: "health.status" }, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await call(port, { method: "health.status" }, { headers: { authorization: "Bearer s3cret" } })).status, 200);
    assert.equal((await call(port, { method: "health.status" }, { headers: { "x-gatecraft-token": "s3cret" } })).status, 200);
  });
  await withServer({ api: false }, async ({ port, api }) => {
    assert.equal(api, null);
    assert.equal((await call(port, { method: "health.status" })).status, 405);
  });
});

test("handleApi never throws, whatever it is handed", async () => {
  for (const body of [null, 42, "text", [], { method: "program.run", params: { spec: {} } }, { method: "circuit.simulate", params: { netlistHex: "zz", nIn: 1, nOut: 1, inputs: [0] } }]) {
    const r = await handleApi(body);
    assert.equal(r.body.ok, false, JSON.stringify(body));
    assert.ok(["bad_request", "unknown_method", "failed"].includes(r.body.error.code), r.body.error.code);
  }
  assert.ok(Object.keys(METHODS).every((name) => /^[a-z]+\.[a-z]+$/.test(name)), "methods are named area.action");
});

test("the preview slot serves a posted page back with its own policy, so an exported app looks right", async () => {
  await withServer({}, async ({ port }) => {
    const app = "<!doctype html><html><head><style>body{color:red}</style></head><body>hi<script>1</script></body></html>";
    const posted = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/preview", method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "text/html", "content-length": Buffer.byteLength(app) } }, (res) => {
        let out = "";
        res.on("data", (c) => { out += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
      });
      req.on("error", reject);
      req.end(app);
    });
    assert.equal(posted.status, 200);
    assert.match(posted.body.result.url, /^\/preview\/[a-z0-9]+$/);

    const got = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: posted.body.result.url, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let out = "";
        res.on("data", (c) => { out += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(got.status, 200);
    assert.equal(got.body, app);
    // its own policy: inline style and script allowed, no network at all
    assert.match(got.headers["content-security-policy"], /default-src 'none'/);
    assert.match(got.headers["content-security-policy"], /style-src 'unsafe-inline'/);
    assert.equal(got.headers["x-frame-options"], "SAMEORIGIN");

    const missing = await call(port, undefined, { method: "GET" });
    assert.equal(missing.status, 200); // /api still answers
    const gone = await new Promise((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/preview/nope", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.end();
    });
    assert.equal(gone, 404);
  });
});

// The decision flow through the local API. The browser cannot call the decision model itself -
// its replies carry no access-control-allow-origin - so this server fills the table with the
// key sitting in the machine's own config, and the key never enters a page.
test("a decision can be reviewed, filled, frozen, drawn, calibrated and exported over the API", async () => {
  const spec = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));
  const call = (method, params, ctx = {}) => handleApi({ method, params }, ctx);

  const read = await call("decision.review", { spec });
  assert.equal(read.status, 200);
  assert.equal(read.body.result.legal, 192);
  assert.ok(read.body.result.notes.some((n) => n.kind === "safe"), "the read-back always raises safe");

  // Filled by the spec's own rule, so no key and no network are involved.
  const filled = await call("decision.fill", { spec, rule: spec.rule });
  assert.equal(filled.body.result.answered, 192);
  assert.equal(filled.body.result.failed, 0);
  const fill = filled.body.result.fill;

  const frozen = await call("decision.freeze", { spec, fill, steps: 400 });
  assert.equal(frozen.body.result.certificate.verification.wrong, 0);
  assert.equal(frozen.body.result.certificate.decision.policy.checkedAgainstAPerson, false);

  // The codebook travels with the netlist: a caller who has both can run the proven circuit
  // itself, which is what the page does instead of asking the server what it answers.
  const book = frozen.body.result.codebook;
  assert.deepEqual(book.observe.map((f) => f.field), Object.keys(spec.observe));
  assert.equal(book.act.choices.length, Object.keys(spec.act.choices).length);
  assert.match(book.packing, /least significant bit first/);
  {
    const { decodeCircuit, hexToBytes, simulate } = await import("../src/netlist.mjs");
    const net = frozen.body.result.netlist;
    const circuit = decodeCircuit(hexToBytes(net.netlistHex), net.nIn, net.nOut);
    // An illegal code - one with no phrase - must come back as the safe action with review set,
    // and that has to hold through the circuit, not just through the table.
    const widths = book.observe.map((f) => [f.field, f.width, Object.keys(f.values).map(Number)]);
    let row = 0, shift = 0, madeIllegal = false;
    for (const [, width, legalCodes] of widths) {
      const illegal = [...Array(2 ** width).keys()].find((c) => !legalCodes.includes(c));
      const pick = !madeIllegal && illegal !== undefined ? (madeIllegal = true, illegal) : legalCodes[0];
      row |= pick << shift;
      shift += width;
    }
    assert.ok(madeIllegal, "charge-throttle has a code with no phrase");
    const out = simulate(circuit, Array.from({ length: net.nIn }, (_, i) => (row >>> i) & 1), new Uint8Array(0));
    let code = 0;
    for (let b = 0; b < book.act.bits; b++) code |= (out.outputs[b] ? 1 : 0) << b;
    assert.equal(book.act.choices[code].choice, book.act.safe);
    assert.equal(out.outputs[book.act.bits], 1, "an illegal situation reviews, by construction");
  }

  const drawn = await call("decision.anchors", { spec, fill, count: 10 });
  const sheet = drawn.body.result.sheet;
  assert.ok(sheet.anchors.length >= 5);
  assert.ok(sheet.anchors.every((a) => a.choice === null));
  assert.doesNotMatch(JSON.stringify(sheet), /"confidence"/, "a drawn question must not carry the model's answer");

  const anchors = { anchors: sheet.anchors.map((a) => ({ ...a, choice: "stop" })) };
  const cal = await call("decision.calibrate", { spec, fill, anchors, rule: spec.rule });
  assert.ok(["delegate", "write-the-rule-instead", "do-not-delegate"].includes(cal.body.result.verdict));

  const out = await call("decision.export", { spec, fill, steps: 400 });
  assert.match(out.body.result.name, /charge-throttle\.decision\.mjs$/);
  assert.match(out.body.result.text, /export function decide/);
});

test("the server's own decision key is never handed to a caller, and its absence is said plainly", async () => {
  const spec = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));

  // health says whether a key is readable, and never what it is.
  const withKey = await handleApi({ method: "health.status" }, { decisionKey: "secret-value" });
  assert.equal(withKey.body.result.decisionKey, "present");
  assert.equal(withKey.body.result.holdsKeys, false, "nothing a caller sends is kept; that is a different claim");
  assert.doesNotMatch(JSON.stringify(withKey.body), /secret-value/);
  assert.equal((await handleApi({ method: "health.status" }, {})).body.result.decisionKey, "absent");

  // Asking the model with no key on the machine is refused with the way out, not a stack trace.
  const refused = await handleApi({ method: "decision.fill", params: { spec } }, {});
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error.message, /jev\.token|typesafe\.ai/);

  // And when there is a key, it goes to the provider and nowhere else.
  const seen = [];
  const fetchStub = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return { status: 200, json: async () => ({ answers: { q: { choice: "stop", confidence: 0.9 } } }) };
  };
  const done = await handleApi({ method: "decision.fill", params: { spec, concurrency: 4 } }, { decisionKey: "k", fetch: fetchStub });
  assert.equal(done.body.result.answered, 192);
  assert.ok(seen.every((s) => s.url.startsWith("https://api.typesafe.ai/")));
  assert.ok(seen.every((s) => s.auth === "Bearer k"));
  assert.doesNotMatch(JSON.stringify(done.body.result).slice(0, 4000), /Bearer|"k"/);
});
