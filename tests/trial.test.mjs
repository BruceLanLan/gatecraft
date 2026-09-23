// The free fills: a few per address, paid by the project's key, which must never reach anyone.
// Driven end to end - the local API asks the Worker for a token and fills through it - against
// an in-memory KV and a fake decision model, so no network and no money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleApi } from "../src/api.mjs";
import { handle } from "../trial/worker.mjs";

const spec = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));
const KEY = "project-key-that-must-never-leak";

function world({ limit = 3, daily = 200, minutes = 20 } = {}) {
  const store = new Map();
  const env = {
    TRIAL: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
    SALT: "salt", TOKEN_SECRET: "secret", JEV_KEY: KEY,
    LIMIT_PER_IP: String(limit), DAILY_FILLS: String(daily), TOKEN_MINUTES: String(minutes),
  };
  const clock = { now: Date.parse("2026-09-23T10:00:00Z") };
  const seen = { keys: new Set(), calls: 0 };
  // The decision model: answers every situation, and records which key it was paid with.
  const fetchJev = async (_url, init) => {
    seen.keys.add(init.headers.authorization);
    seen.calls += 1;
    return new Response(JSON.stringify({ answers: { q: { choice: "slow", confidence: 0.9 } } }), { status: 200 });
  };
  const leaks = [];
  // What the local gatecraft sees: every request to the trial host goes through the Worker,
  // arriving from `ip`.
  const from = (ip) => async (url, init = {}) => {
    const request = new Request(url, { ...init, headers: { ...(init.headers ?? {}), "cf-connecting-ip": ip } });
    const response = await handle(request, env, { now: clock.now, fetchJev });
    const text = await response.text();
    if (text.includes(KEY)) leaks.push(url);
    return new Response(text, { status: response.status, headers: response.headers });
  };
  return { env, store, clock, seen, leaks, from };
}

const fill = (fetch) => handleApi({ method: "decision.fill", params: { spec } }, { decisionKey: null, trial: "https://trial.test", fetch });

test("a machine with no key gets three free fills, through the same model, and then is pointed elsewhere", async () => {
  const w = world();
  const me = w.from("203.0.113.7");
  for (const left of [2, 1, 0]) {
    const r = await fill(me);
    assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
    assert.equal(r.body.result.answered, 192);
    assert.equal(r.body.result.trial.left, left);
  }
  const fourth = await fill(me);
  assert.equal(fourth.body.ok, false);
  assert.match(fourth.body.error.message, /3 free fills for this address are used/);
  assert.match(fourth.body.error.message, /your own model/, "the way out is named, not just the refusal");

  // The model was paid with the project's key, and that key never came back to the client.
  assert.deepEqual([...w.seen.keys], [`Bearer ${KEY}`]);
  assert.deepEqual(w.leaks, []);
  // Only counts are stored, and the address itself is not among them.
  assert.ok(![...w.store.keys()].some((k) => k.includes("203.0.113.7")));

  // Another address still has its own three.
  const status = await handleApi({ method: "decision.trial" }, { trial: "https://trial.test", fetch: w.from("198.51.100.4") });
  assert.deepEqual([status.body.result.available, status.body.result.left], [true, 3]);
});

test("a trial token works only from its own address, only until it expires, and only for the model's request", async () => {
  const w = world();
  const start = async (ip) => (await w.from(ip)("https://trial.test/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ situations: 2 }) })).json();
  const ask = (ip, token, body = { model: "jev-latest", state: { a: "b" }, questions: { q: {} } }) =>
    w.from(ip)("https://trial.test/v1/systemone", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  const { token } = await start("203.0.113.7");
  assert.equal((await ask("203.0.113.7", token)).status, 200);
  assert.equal((await ask("198.51.100.4", token)).status, 401, "a token lifted to another address is refused");
  assert.equal((await ask("203.0.113.7", `${token}x`)).status, 401, "a forged token is refused");
  assert.equal((await ask("203.0.113.7", token, { model: "something-else", state: {}, questions: {} })).status, 400, "the key is only lent for the decision model's own request");

  // Two situations allow eight calls; the ninth is refused however valid the token.
  for (let i = 0; i < 7; i++) await ask("203.0.113.7", token);
  assert.equal((await ask("203.0.113.7", token)).status, 429);

  const later = await start("203.0.113.7");
  w.clock.now += 21 * 60_000;
  assert.equal((await ask("203.0.113.7", later.token)).status, 401, "an expired token is refused");
});

test("the day has a ceiling across everyone, and a decision too large for a free fill is refused before any call", async () => {
  const w = world({ daily: 2 });
  assert.equal((await fill(w.from("192.0.2.1"))).body.ok, true);
  assert.equal((await fill(w.from("192.0.2.2"))).body.ok, true);
  const third = await fill(w.from("192.0.2.3"));
  assert.equal(third.body.ok, false);
  assert.match(third.body.error.message, /Today's free fills are all taken/);

  const big = await (await w.from("192.0.2.9")("https://trial.test/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ situations: 513 }) })).json();
  assert.equal(big.error, "too_large");
  assert.equal(w.seen.calls, 2 * 192, "only the two fills that were allowed reached the model");
});

test("a Worker missing any of its secrets refuses rather than signing with an empty one", async () => {
  const w = world();
  for (const missing of ["SALT", "TOKEN_SECRET", "JEV_KEY"]) {
    const env = { ...w.env, [missing]: undefined };
    const r = await handle(new Request("https://trial.test/start", { method: "POST", body: JSON.stringify({ situations: 2 }) }), env);
    assert.equal(r.status, 503, `${missing} missing`);
  }
});

test("mounted under a path on another site, it answers only there and hands back URLs under it", async () => {
  const w = world();
  w.env.BASE_PATH = "/gatecraft";
  const r = await fill((url, init) => w.from("203.0.113.7")(url, init));
  assert.equal(r.body.ok, false, "the unprefixed paths are not served when mounted");
  const mounted = await handleApi({ method: "decision.fill", params: { spec } }, { decisionKey: null, trial: "https://trial.test/gatecraft", fetch: w.from("203.0.113.7") });
  assert.equal(mounted.body.ok, true, JSON.stringify(mounted.body.error));
  assert.equal(mounted.body.result.answered, 192);
  const started = await (await w.from("198.51.100.4")("https://trial.test/gatecraft/start", { method: "POST", body: JSON.stringify({ situations: 1 }) })).json();
  assert.equal(started.url, "https://trial.test/gatecraft/v1/systemone");
  assert.equal((await w.from("198.51.100.4")("https://trial.test/elsewhere")).status, 404, "the rest of the site is not this Worker's");
});

test("with no trial configured, a machine without a key is told how to get one", async () => {
  const r = await handleApi({ method: "decision.fill", params: { spec } }, { decisionKey: null, trial: null });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error.message, /jev\.token/);
  assert.deepEqual((await handleApi({ method: "decision.trial" }, { trial: null })).body.result, { available: false });
});
