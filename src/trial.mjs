// The free fills: a few calibrated fills per address, so a first-time user sees the whole flow
// before signing up for anything. The Worker that pays for them is in trial/worker.mjs; this is
// the client side, used only when this machine has no decision-model key of its own.
//
// It never replaces a key you have, and it can be switched off: GATECRAFT_TRIAL=off, or point
// GATECRAFT_TRIAL_URL somewhere else. Nothing about the person is sent - the Worker counts by
// the address the request comes from, hashed, and that is all it keeps.

// The project's own free-trial service (trial/worker.mjs), mounted on the project's site. Its key
// never leaves the Worker.
export const DEFAULT_TRIAL_URL = "https://tapeout.work/gatecraft";

export function trialUrl(env = process.env) {
  if (/^(off|0|false|no)$/i.test(env.GATECRAFT_TRIAL ?? "")) return null;
  const url = (env.GATECRAFT_TRIAL_URL ?? DEFAULT_TRIAL_URL ?? "").trim().replace(/\/+$/, "");
  return url || null;
}

async function call(fetch, url, init) {
  let response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }); }
  catch (error) { throw new Error(`the free-trial service did not answer (${error.name === "TimeoutError" ? "timed out" : error.message})`); }
  let body = null;
  try { body = await response.json(); } catch { /* the status says enough */ }
  return { status: response.status, body };
}

// How many free fills this address has left, or null when there is no trial to ask.
export async function trialStatus({ url = trialUrl(), fetch = globalThis.fetch } = {}) {
  if (!url) return null;
  const { status, body } = await call(fetch, `${url}/status`, { method: "GET" });
  if (status !== 200 || !Number.isInteger(body?.left)) return null;
  return { left: body.left, limit: body.limit, maxSituations: body.maxSituations };
}

// One free fill: a short-lived token and the endpoint to send the situations to.
export async function startTrial(situations, { url = trialUrl(), fetch = globalThis.fetch } = {}) {
  if (!url) throw new Error("no free-trial service is configured");
  const { status, body } = await call(fetch, `${url}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ situations }) });
  if (status !== 200 || !body?.token) throw new Error(body?.message ?? `the free-trial service answered ${status}`);
  return { token: body.token, jevUrl: body.url, left: body.left, limit: body.limit };
}
