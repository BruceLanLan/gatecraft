// Local web server for the browser UI and the local API. It serves ui/, src/ and examples/
// from this checkout on 127.0.0.1 only, and answers POST /api for other programs on this
// machine (src/api.mjs). It writes no files, holds no keys and signs nothing.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { decisionKey, forgetDecisionKey, keyDir as defaultKeyDir, saveDecisionKey } from "./decisionkey.mjs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, MAX_BODY_BYTES, METHODS } from "./api.mjs";

// The machine's own decision-model key, read here and never sent to the browser. The page asks
// this server to fill a table; the key stays on the far side of that call. Read per request so
// dropping the file in takes effect without a restart.



const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVED = new Set(["ui", "src", "examples"]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
// 'unsafe-eval' because table expressions are compiled with new Function; the
// RPC for a tape-out plan is whatever address the user types, hence http(s): in connect-src.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' http: https:",
  "worker-src 'self'",
  // The page previews the app it just exported, served back from /preview/<id>.
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Reads a request body up to `limit`. Past it the body is dropped but still drained, so the
// caller gets the refusal instead of a broken connection; past DRAIN_LIMIT the socket goes.
// A page the browser hands back to be previewed in a frame (the exported app). A blob or a
// data: URL would inherit this page's own policy, which forbids the inline style and script
// such a file is made of, so the server holds it for a moment and serves it with a policy of
// its own: no network at all, inline style and script only, nothing else.
const PREVIEW_SLOTS = 4;
const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const DRAIN_LIMIT = 64 * 1024 * 1024;
const readBody = (req, limit) => new Promise((resolve, reject) => {
  let size = 0;
  let chunks = [];
  let tooLarge = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit && !tooLarge) {
      tooLarge = true;
      chunks = [];
    }
    if (!tooLarge) chunks.push(chunk);
    else if (size > DRAIN_LIMIT) req.destroy();
  });
  req.on("end", () => resolve(tooLarge ? { tooLarge: true, size } : { text: Buffer.concat(chunks).toString("utf8") }));
  req.on("error", reject);
});

// `apiToken`, when set, must arrive as `authorization: Bearer <token>` or `x-gatecraft-token`.
// Without one, loopback plus the Host and Origin checks are the whole fence, as they are for
// the page itself.
// `added` is what loadApiPlugins() returned: extra methods for /api and extra exact routes,
// both behind the same fence as everything else here.
// One served file, or null when the path names nothing we serve. Shared with the harness
// plugin so both carriers hand out exactly the same three folders.
export async function servedFile(path) {
  let clean;
  try {
    clean = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (clean.endsWith("/")) clean += "index.html";
  const parts = clean.split("/").filter(Boolean);
  if (!SERVED.has(parts[0]) || parts.some((part) => part.startsWith(".") || part.includes("\\") || part.includes("\0"))) return null;
  const type = TYPES[extname(clean)];
  if (!type) return null;
  const file = join(ROOT, ...parts);
  try {
    if (!(await stat(file)).isFile()) return null;
    return { type, body: await readFile(file) };
  } catch {
    return null;
  }
}

export function startUiServer({ port = 4747, host = "127.0.0.1", apiToken = null, api = true, added = null, keyDir = defaultKeyDir() } = {}) {
  // What the page may do with the key file: write it for you, or remove it. Never read it back.
  const keyStore = { save: (key) => saveDecisionKey(key, { dir: keyDir }), forget: () => forgetDecisionKey({ dir: keyDir }) };
  const methods = added?.methods && Object.keys(added.methods).length ? { ...METHODS, ...added.methods } : METHODS;
  const plugins = added?.plugins ?? [];
  const routes = api ? (added?.routes ?? []) : [];
  const previews = new Map();
  const server = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": CSP,
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const bound = server.address().port;
    const json = (status, body) => send(status, `${JSON.stringify(body, null, 1)}\n`, { "content-type": "application/json; charset=utf-8" });
    // Another site resolving its own name to 127.0.0.1 must not be able to read these files,
    // nor drive the API from a page it serves.
    if (![`127.0.0.1:${bound}`, `localhost:${bound}`].includes(req.headers.host)) return send(403, "forbidden host\n");
    const origin = req.headers.origin;
    const originOk = req.headers["sec-fetch-site"] !== "cross-site"
      && (!origin || [`http://127.0.0.1:${bound}`, `http://localhost:${bound}`].includes(origin));
    const tokenOk = () => {
      if (!apiToken) return true;
      const header = req.headers.authorization ?? "";
      const given = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-gatecraft-token"];
      return given === apiToken;
    };

    let path;
    try {
      path = decodeURIComponent(new URL(req.url, "http://local").pathname);
    } catch {
      return send(400, "bad path\n");
    }
    if (api && (path === "/api" || path === "/api/")) {
      if (!originOk) return json(403, { ok: false, error: { code: "forbidden_origin", message: "the API answers requests from this machine, not from another site's page" } });
      if (!tokenOk()) return json(401, { ok: false, error: { code: "unauthorized", message: "this server was started with a token; send it as authorization: Bearer <token>" } });
      // A GET lists what the API answers, the way the page's own address does.
      if (req.method === "GET" || req.method === "HEAD") return json(200, { ok: true, method: "health.status", result: METHODS["health.status"]({}, { methods, plugins, decisionKey: decisionKey({ dir: keyDir }), keyStore }) });
      if (req.method !== "POST") return send(405, "method not allowed\n", { allow: "GET, HEAD, POST" });
      let read;
      try {
        read = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        return json(400, { ok: false, error: { code: "bad_request", message: error.message } });
      }
      if (read.tooLarge) return json(413, { ok: false, error: { code: "too_large", message: `the request body is larger than ${MAX_BODY_BYTES} bytes` } });
      let body;
      try {
        body = JSON.parse(read.text);
      } catch (error) {
        return json(400, { ok: false, error: { code: "bad_request", message: `the body is not JSON: ${error.message}` } });
      }
      const answer = await handleApi(body, { methods, plugins, decisionKey: decisionKey({ dir: keyDir }), keyStore });
      return json(answer.status, answer.body);
    }
    // The preview slot: the page posts a page, gets an id, and frames it back.
    if (api && path === "/preview") {
      if (!originOk) return send(403, "forbidden origin\n");
      if (!tokenOk()) return json(401, { ok: false, error: { code: "unauthorized", message: "this server was started with a token" } });
      if (req.method !== "POST") return send(405, "method not allowed\n", { allow: "POST" });
      const read = await readBody(req, MAX_BODY_BYTES).catch(() => ({ tooLarge: true }));
      if (read.tooLarge || !read.text) return json(413, { ok: false, error: { code: "too_large", message: `a preview must be under ${MAX_BODY_BYTES} bytes` } });
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      previews.set(id, read.text);
      while (previews.size > PREVIEW_SLOTS) previews.delete(previews.keys().next().value);
      return json(200, { ok: true, result: { url: `/preview/${id}` } });
    }
    if (api && path.startsWith("/preview/")) {
      const held = previews.get(path.slice("/preview/".length));
      if (!held) return send(404, "not found\n");
      return send(200, held, { "content-type": "text/html; charset=utf-8", "content-security-policy": PREVIEW_CSP, "x-frame-options": "SAMEORIGIN" });
    }
    // A plugin's own route, at the exact path it registered.
    const route = routes.find((r) => r.path === path);
    if (route) {
      if (!originOk) return send(403, "forbidden origin\n");
      if (!tokenOk()) return json(401, { ok: false, error: { code: "unauthorized", message: "this server was started with a token" } });
      if (req.method !== route.method && !(route.method === "GET" && req.method === "HEAD")) return send(405, "method not allowed\n", { allow: route.method });
      try {
        await route.handler(req, res);
      } catch (error) {
        if (!res.headersSent) json(500, { ok: false, error: { code: "plugin_failed", message: `${route.plugin}: ${error.message}` } });
        else res.end();
      }
      return undefined;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed\n", { allow: "GET, HEAD" });
    if (!originOk) return send(403, "forbidden origin\n");

    if (path === "/" || path === "/ui") return send(302, "", { location: "/ui/" });
    if (path.endsWith("/")) path += "index.html";
    const parts = path.split("/").filter(Boolean);
    if (!SERVED.has(parts[0]) || parts.some((p) => p.startsWith(".") || p.includes("\\") || p.includes("\0"))) return send(404, "not found\n");
    const type = TYPES[extname(path)];
    if (!type) return send(404, "not found\n");
    const file = join(ROOT, ...parts);
    try {
      if (!(await stat(file)).isFile()) return send(404, "not found\n");
      send(200, await readFile(file), { "content-type": type });
    } catch {
      send(404, "not found\n");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        api: api ? `http://127.0.0.1:${actual}/api` : null,
        port: actual,
        methods: Object.keys(methods),
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => Promise.resolve(added?.dispose?.()).then(done, done));
        }),
      });
    });
  });
}
