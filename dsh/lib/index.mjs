// gatecraft as a harness plugin: the agent gets three tools, and the browser page and the
// local API appear on the harness's own web address under /gatecraft/.
//
// Nothing here changes the compiler: src/ stays zero-dependency and still runs on its own
// (npm run ui, the compile-* commands). This is the glue, and it uses only the public seams
// the harness documents — tools, webServer — the way dsh-remote does.
import { MAX_BODY_BYTES, handleApi } from "../../src/api.mjs";
import { servedFile } from "../../src/ui-server.mjs";
import { buildTools } from "./tools.mjs";

export const name = "gatecraft";
// Without this the row can activate before these services exist, and registration is
// silently skipped.
export const inject = ["tools", "webServer"];

const PREFIX = "/gatecraft/";

const json = (res, status, value) => {
  const body = JSON.stringify(value, null, 1);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
};

const readBody = (req, limit) => new Promise((resolve) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  });
  req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks).toString("utf8")));
});

// POST /gatecraft/api — the same methods the standalone server answers.
export async function apiRoute(req, res) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: { code: "bad_request", message: "POST a JSON body" } });
  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) return json(res, 413, { ok: false, error: { code: "too_large", message: `the body is larger than ${MAX_BODY_BYTES} bytes` } });
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    return json(res, 400, { ok: false, error: { code: "bad_request", message: `the body is not JSON: ${error.message}` } });
  }
  const answer = await handleApi(body);
  return json(res, answer.status, answer.body);
}

// GET /gatecraft/… — the page, its modules and the examples, out of this checkout.
export async function pageRoute(req, res) {
  const path = new URL(req.url, "http://local").pathname.slice(PREFIX.length - 1);
  const file = await servedFile(path === "/" || path === "" ? "/ui/" : path);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("not found\n");
  }
  res.writeHead(200, { "content-type": file.type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  return res.end(req.method === "HEAD" ? undefined : file.body);
}

// `defineTool` comes from the harness's own tools package. It is read once here, not off the
// context: a context only answers for the services in `inject`, and asking it for anything
// else throws.
async function harnessDefineTool() {
  try {
    const module = await import("@deepseek-ai/dsh-tools");
    return typeof module.defineTool === "function" ? module.defineTool : null;
  } catch {
    return null;
  }
}

// Nothing in here may throw: an apply() that throws fails the whole plugin tree, and the
// harness does not start. Every step is guarded and reports itself instead.
export async function apply(ctx) {
  const say = (message) => console.error(`gatecraft: ${message}`);
  const defineTool = await harnessDefineTool();
  if (!defineTool) {
    say('@deepseek-ai/dsh-tools is not resolvable from this plugin, so no tools were registered (the page and the API still are). Install it next to the plugin, e.g. link its directory into dsh/node_modules.');
  }
  let tools = null;
  try {
    tools = ctx.get("tools");
  } catch (error) {
    say(`no tools service: ${error?.message ?? error}`);
  }
  if (tools && defineTool) {
    for (const tool of buildTools({ defineTool })) {
      try {
        tools.register(tool);
      } catch (error) {
        say(`failed to register ${tool.name}: ${error?.message ?? error}`);
      }
    }
  }
  let webServer = null;
  try {
    webServer = ctx.get("webServer");
  } catch (error) {
    say(`no web server: ${error?.message ?? error}`);
  }
  if (!webServer) return;
  for (const route of [
    { kind: "exact", path: "/gatecraft/api", handler: apiRoute },
    { kind: "prefix", path: PREFIX, handler: pageRoute },
  ]) {
    try {
      const dispose = webServer.register(route);
      if (typeof ctx.effect === "function") ctx.effect(() => dispose);
    } catch (error) {
      say(`failed to register ${route.path}: ${error?.message ?? error}`);
    }
  }
}
