// Your own forwarder for the decision model, so the website never has to route your key through
// anyone else's server.
//
// Why a forwarder exists at all: the decision model's API (api.typesafe.ai) does not allow calls
// from web pages - it answers a browser's preflight with no Access-Control-Allow-Origin, for every
// origin - so a page cannot reach it directly. Something with a server has to pass the request on.
// gatecraft.fun offers one (trial.gatecraft.fun); this is the same forwarding and nothing else, to
// deploy on your own Cloudflare account and point the page at.
//
// It does one thing: take the decision model's own request with your key in x-jev-key, send it to
// the model with that key, and hand back the answer. It stores nothing, logs nothing, counts
// nothing, and forwards nothing but that one request shape.
const JEV = "https://api.typesafe.ai/v1/systemone";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, x-jev-key", "access-control-max-age": "86400" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });

export async function handle(request, { fetchJev = fetch } = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/") return new Response("gatecraft forwarder: POST /v1/systemone with your key in x-jev-key.\n", { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
  if (request.method !== "POST" || path !== "/v1/systemone") return json(404, { error: "not_found" });
  const key = (request.headers.get("x-jev-key") ?? "").trim();
  if (!key) return json(401, { error: "unauthorized", message: "send your decision-model key in x-jev-key" });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "bad_request", message: "the body must be the decision model's request" }); }
  if (body?.model !== "jev-latest" || typeof body.state !== "object" || typeof body.questions !== "object") return json(400, { error: "bad_request", message: "expected { model: \"jev-latest\", state, questions }" });
  const answer = await fetchJev(JEV, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: body.model, state: body.state, questions: body.questions }) });
  return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });
}

export default { fetch: (request) => handle(request) };
