// A few free fills for people who have no decision-model key yet.
//
// gatecraft's rule is that whoever uses a model pays for it, and that stays the default: fill
// by rule, with your own model, or with your own key. This Worker is the one exception, so a
// first-time user can see the whole flow with the calibrated model before signing up for
// anything - a handful of fills per address, paid by the project, and then the page points them
// at bringing their own.
//
// It stands in for the decision model's own endpoint. The local gatecraft asks it for a trial
// token once per fill, then sends every situation here exactly as it would to the model; this
// checks the token and forwards the call with the project's key, which never leaves this
// Worker. So the client needs no second code path, and the key is never in anything a user
// downloads.
//
// What is stored: a count per address, where the address is an HMAC under a secret salt - the
// address itself is never written down - and a count per day. Nothing else.
//
// Limits, all from env: LIMIT_PER_IP fills per address, ever (default 3); DAILY_FILLS across
// everyone per UTC day (default 200), so the worst day has a known price; MAX_SITUATIONS per
// fill (default 512); a token lasts TOKEN_MINUTES (default 20) and allows four calls per
// situation, which covers the client's retries.

const JEV = "https://api.typesafe.ai/v1/systemone";
const enc = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

const settings = (env) => ({
  perIp: Number(env.LIMIT_PER_IP ?? 3),
  daily: Number(env.DAILY_FILLS ?? 200),
  maxSituations: Number(env.MAX_SITUATIONS ?? 512),
  minutes: Number(env.TOKEN_MINUTES ?? 20),
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// What a person is told when the free fills are gone, or were never there. Always the same
// three ways out, because the point of the trial is to lead somewhere.
const WAYS_OUT = "Fill with your own model (any provider you already use, or a model on your own computer), fill from a rule if the decision has one, or get a free key at https://typesafe.ai and save it to ~/.config/gatecraft/jev.token.";

async function addressKey(env, request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return `ip:${(await hmac(env.SALT, ip)).slice(0, 32)}`;
}

async function sign(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env.TOKEN_SECRET, body)}`;
}

async function verify(env, token) {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac || (await hmac(env.TOKEN_SECRET, body)) !== mac) return null;
  try { return JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return null; }
}

// Calls per token, counted in this isolate. Not global - a token's calls can land on different
// isolates - but a token is bound to one address, short-lived, and capped at four calls a
// situation, so what slips past this is bounded by the token, not open-ended.
const spent = new Map();

export async function handle(request, env, { now = Date.now(), fetchJev = fetch } = {}) {
  // A missing secret would not fail loudly on its own: HMAC over the string "undefined" works,
  // and tokens signed with it could be forged by anyone who read this file. Refuse instead.
  if (!env.SALT || !env.TOKEN_SECRET || !env.JEV_KEY || !env.TRIAL) return json(503, { error: "not_configured", message: `The free trial is not available right now. ${WAYS_OUT}` });
  const url = new URL(request.url);
  const s = settings(env);
  const day = new Date(now).toISOString().slice(0, 10);

  if (request.method === "GET" && url.pathname === "/status") {
    const used = Number((await env.TRIAL.get(await addressKey(env, request))) ?? 0);
    return json(200, { left: Math.max(0, s.perIp - used), limit: s.perIp, maxSituations: s.maxSituations, waysOut: WAYS_OUT });
  }

  if (request.method === "POST" && url.pathname === "/start") {
    let asked;
    try { asked = await request.json(); } catch { return json(400, { error: "bad_request", message: "send { situations: n }" }); }
    const n = asked?.situations;
    if (!Number.isInteger(n) || n < 1) return json(400, { error: "bad_request", message: "situations must be a positive whole number" });
    if (n > s.maxSituations) return json(413, { error: "too_large", message: `a free fill covers up to ${s.maxSituations} situations; this decision has ${n}. ${WAYS_OUT}` });
    const who = await addressKey(env, request);
    const used = Number((await env.TRIAL.get(who)) ?? 0);
    if (used >= s.perIp) return json(429, { error: "used_up", left: 0, message: `The ${s.perIp} free fills for this address are used. ${WAYS_OUT}` });
    const today = Number((await env.TRIAL.get(`day:${day}`)) ?? 0);
    if (today >= s.daily) return json(503, { error: "daily_limit", left: s.perIp - used, message: `Today's free fills are all taken; try again tomorrow (UTC). ${WAYS_OUT}` });
    await env.TRIAL.put(who, String(used + 1));
    await env.TRIAL.put(`day:${day}`, String(today + 1), { expirationTtl: 3 * 86400 });
    const token = await sign(env, { who, calls: n * 4, exp: now + s.minutes * 60_000, id: crypto.randomUUID() });
    return json(200, { token, left: s.perIp - used - 1, limit: s.perIp, url: `${url.origin}/v1/systemone`, expiresAt: new Date(now + s.minutes * 60_000).toISOString() });
  }

  if (request.method === "POST" && url.pathname === "/v1/systemone") {
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const claim = await verify(env, token);
    if (!claim) return json(401, { error: "unauthorized", message: "not a trial token from this service" });
    if (now > claim.exp) return json(401, { error: "expired", message: "this free fill's token has expired; start the fill again" });
    if (claim.who !== (await addressKey(env, request))) return json(401, { error: "unauthorized", message: "a trial token only works from the address that started it" });
    const count = (spent.get(claim.id) ?? 0) + 1;
    if (count > claim.calls) return json(429, { error: "token_spent", message: "this free fill has made all the calls it is allowed" });
    spent.set(claim.id, count);
    if (spent.size > 10_000) spent.clear();

    let body;
    try { body = await request.json(); } catch { return json(400, { error: "bad_request", message: "the body must be the decision model's request" }); }
    // Only the decision model's own request shape is forwarded, so the key cannot be used for
    // anything else this endpoint would not have done anyway.
    if (body?.model !== "jev-latest" || typeof body.state !== "object" || typeof body.questions !== "object") return json(400, { error: "bad_request", message: "expected { model: \"jev-latest\", state, questions }" });
    const answer = await fetchJev(JEV, { method: "POST", headers: { authorization: `Bearer ${env.JEV_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: body.model, state: body.state, questions: body.questions }) });
    return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }

  if (request.method === "GET" && url.pathname === "/") {
    return new Response(`gatecraft free trial: ${s.perIp} free fills per address, then bring your own model or key.\nhttps://github.com/BruceLanLan/gatecraft\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return json(404, { error: "not_found" });
}

export default { fetch: (request, env) => handle(request, env) };
