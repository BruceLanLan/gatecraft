// The deploy-your-own forwarder: passes the decision model's request on with the caller's key,
// and does nothing else.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleApi } from "../src/api.mjs";
import { handle } from "../forwarder/worker.mjs";

const spec = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));

test("your own forwarder carries your key to the model, and nothing else", async () => {
  const keys = [];
  const fetchJev = async (_url, init) => { keys.push(init.headers.authorization); return new Response(JSON.stringify({ answers: { q: { choice: "slow", confidence: 0.9 } } }), { status: 200 }); };
  const via = (url, init = {}) => handle(new Request(url, init), { fetchJev });
  const ok = { model: "jev-latest", state: { a: "b" }, questions: { q: {} } };
  const post = (headers, body = ok) => via("https://mine.test/v1/systemone", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  assert.equal((await post({ "x-jev-key": "mine" })).status, 200);
  assert.deepEqual(keys, ["Bearer mine"]);
  assert.equal((await post({})).status, 401, "no key, no call");
  assert.equal((await post({ "x-jev-key": "mine" }, { model: "other", state: {}, questions: {} })).status, 400, "only the model's own request");
  assert.equal((await via("https://mine.test/anything", { method: "POST" })).status, 404);
  const pre = await via("https://mine.test/v1/systemone", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  // The page sends Authorization as well as x-jev-key; a preflight that does not allow it makes
  // the browser drop every call before it leaves - which a test outside a browser cannot see, so
  // the allowed headers are pinned here. It happened: 432 calls, none answered.
  for (const h of ["authorization", "content-type", "x-jev-key"]) assert.match(pre.headers.get("access-control-allow-headers"), new RegExp(h));

  // And the page's fill goes through it end to end when pointed at it.
  const r = await handleApi({ method: "decision.fill", params: { spec } }, { decisionKey: "mine", jevProxy: "https://mine.test", fetch: via });
  assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
  assert.equal(r.body.result.answered, 192);
  assert.ok(keys.every((k) => k === "Bearer mine"));
});
