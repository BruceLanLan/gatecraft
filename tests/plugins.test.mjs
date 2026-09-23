// Adding your own API: a plugin exports a name and an apply(ctx), registers methods and
// routes through ctx, and is fenced and namespaced like everything else on this server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { METHODS, handleApi } from "../src/api.mjs";
import { loadApiPlugins, pluginDir, pluginsInDir } from "../src/plugins.mjs";
import { startUiServer } from "../src/ui-server.mjs";
import { ROOT, tempDir } from "./helpers.mjs";

const fixture = (file) => join(ROOT, "tests", "fixtures", file);
const quiet = () => {
  const said = [];
  return { log: (...args) => said.push(args.join(" ")), said };
};

function fetchJson(port, path, { body, method = "POST", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers } }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(out);
        } catch {
          // plain text
        }
        resolve({ status: res.statusCode, body: parsed, text: out });
      });
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : text);
  });
}

test("a plugin's methods and routes are served, namespaced under its own name", async () => {
  const added = await loadApiPlugins([fixture("plugin-cost.mjs")], quiet());
  assert.deepEqual(added.problems, []);
  assert.deepEqual(added.plugins, [{ name: "cost", file: fixture("plugin-cost.mjs"), methods: ["cost.of", "cost.ofProgram"], routes: ["GET /cost/ping"] }]);

  const server = await startUiServer({ port: 0, added });
  try {
    const { port } = server;
    assert.ok(server.methods.includes("cost.of"));
    const listed = await fetchJson(port, "/api", { method: "GET" });
    assert.ok(listed.body.result.methods.includes("cost.ofProgram"));
    assert.deepEqual(listed.body.result.plugins[0].methods, ["cost.of", "cost.ofProgram"]);

    const cost = await fetchJson(port, "/api", { body: { method: "cost.of", params: { nand: 6, depth: 4 } } });
    assert.deepEqual(cost.body, { ok: true, method: "cost.of", result: { podCost: 384 } });

    // a plugin method that calls a built-in one
    const vote = { inputs: { a: 1, b: 1, c: 1 }, outputs: { pass: { width: 1, expr: "a + b + c >= 2" } } };
    const built = await fetchJson(port, "/api", { body: { method: "cost.ofProgram", params: { spec: vote, name: "vote", steps: 2000 } } });
    assert.equal(built.body.result.nand, 6);
    assert.equal(built.body.result.podCost, built.body.result.nand * built.body.result.depth ** 3);

    // its own error code survives, and a built-in method is unchanged
    const bad = await fetchJson(port, "/api", { body: { method: "cost.of", params: { nand: "six" } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "bad_request");
    const health = await fetchJson(port, "/api", { body: { method: "health.status" } });
    assert.equal(health.body.result.compiler.startsWith("gatecraft"), true);

    // the route it registered, behind the same fence
    const ping = await fetchJson(port, "/cost/ping", { method: "GET" });
    assert.equal(ping.text, "cost plugin here\n");
    assert.equal((await fetchJson(port, "/cost/ping", { method: "POST", body: {} })).status, 405);
    const crossSite = await fetchJson(port, "/cost/ping", { method: "GET", headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    assert.equal((await fetchJson(port, "/cost/nope", { method: "GET" })).status, 404);
  } finally {
    globalThis.__costPluginDisposed = false;
    await server.close();
  }
  assert.equal(globalThis.__costPluginDisposed, true, "closing the server runs a plugin's cleanup");
});

test("a plugin that cannot load, or misbehaves, is skipped with a reason and the rest still work", async () => {
  const log = quiet();
  const added = await loadApiPlugins([fixture("plugin-broken.mjs"), fixture("plugin-nameless.mjs"), fixture("plugin-greedy.mjs"), fixture("plugin-cost.mjs"), fixture("plugin-cost.mjs")], log);
  assert.match(added.problems[0], /plugin-broken\.mjs did not load: this plugin is broken on purpose/);
  assert.match(added.problems[1], /plugin-nameless\.mjs needs an exported name/);
  assert.match(added.problems[2], /calls itself "cost", which another plugin already registered/);
  assert.equal(added.problems.length, 3);
  assert.equal(log.said.length, 3);
  assert.deepEqual(Object.keys(added.methods).sort(), ["cost.of", "cost.ofProgram", "greedy.ok"]);

  const greedy = await import(`${fixture("plugin-greedy.mjs")}`);
  assert.deepEqual(greedy.attempts, [
    "same method twice: method greedy.ok is already registered",
    'outside route: route "/api" must start with "/greedy/"',
    'bad method name: method name "Not A Name" must be lowercase-ish letters and digits',
    "bad verb: route /greedy/x must be GET or POST",
  ]);

  // a plugin's methods always sit under its own name, so a built-in one cannot be shadowed
  assert.equal("cost.of" in METHODS, false);
  assert.equal(Object.keys(added.methods).every((m) => m.startsWith("cost.") || m.startsWith("greedy.")), true);
  const direct = await handleApi({ method: "cost.of" });
  assert.equal(direct.status, 404);
});

test("plugins are picked up from the directory, and a token covers their routes too", async () => {
  const home = tempDir();
  const dir = pluginDir(home);
  assert.equal(dir, join(home, ".config", "gatecraft", "api-plugins"));
  assert.deepEqual(await pluginsInDir(dir), []);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hello.mjs"), 'export const name = "hello";\nexport function apply(ctx) {\n  ctx.method("there", () => ({ hi: true }));\n  ctx.route("/hello/x", "GET", (req, res) => { res.writeHead(204); res.end(); });\n}\n');
  writeFileSync(join(dir, "notes.txt"), "ignored");
  assert.deepEqual(await pluginsInDir(dir), [join(dir, "hello.mjs")]);

  const added = await loadApiPlugins(await pluginsInDir(dir), quiet());
  const server = await startUiServer({ port: 0, apiToken: "t0ken", added });
  try {
    const { port } = server;
    assert.equal((await fetchJson(port, "/api", { body: { method: "hello.there" } })).status, 401);
    const ok = await fetchJson(port, "/api", { body: { method: "hello.there" }, headers: { authorization: "Bearer t0ken" } });
    assert.deepEqual(ok.body.result, { hi: true });
    assert.equal((await fetchJson(port, "/hello/x", { method: "GET" })).status, 401);
    assert.equal((await fetchJson(port, "/hello/x", { method: "GET", headers: { "x-gatecraft-token": "t0ken" } })).status, 204);
  } finally {
    await server.close();
  }
});
