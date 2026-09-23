// The harness plugin: three tools for the agent, two routes for the page and the API. Checked
// against a stub context, so this runs without a harness.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { apiRoute, apply, inject, name, pageRoute } from "../dsh/lib/index.mjs";
import { buildTools } from "../dsh/lib/tools.mjs";
import { ROOT } from "./helpers.mjs";

const VOTE = {
  inputs: { a: 1, b: 1, c: 1 },
  outputs: { pass: { width: 1, expr: "a + b + c >= 2" } },
  examples: [{ given: { a: 1, b: 1, c: 0 }, expect: { pass: 1 } }, { given: { a: 0, b: 0, c: 1 }, expect: { pass: 0 } }],
};

// The harness's context answers only for the services a plugin declared in `inject`, and
// throws for anything else — including a property that does not exist. A plugin that reads
// one takes the whole harness down with it, which is exactly what happened once.
function strictContext(services, registered) {
  return new Proxy({}, {
    get(_target, key) {
      if (key === "get") {
        return (name) => {
          if (!(name in services)) throw new Error(`cannot get property ${JSON.stringify(name)} without inject`);
          return services[name];
        };
      }
      if (key === "effect") return (fn) => registered.effects.push(fn);
      if (key === "then") return undefined;
      throw new Error(`cannot get property ${JSON.stringify(String(key))} without inject`);
    },
  });
}

function stubContext({ webServer = true, breakRoute = null, tools = true } = {}) {
  const registered = { tools: [], routes: [], effects: [] };
  const services = {
    tools: tools ? { register: (tool) => registered.tools.push(tool.name) } : undefined,
    webServer: webServer ? {
      register: (route) => {
        if (route.path === breakRoute) throw new Error("path already taken");
        registered.routes.push(`${route.kind} ${route.path}`);
        return () => registered.routes.splice(registered.routes.indexOf(`${route.kind} ${route.path}`), 1);
      },
    } : null,
  };
  if (!tools) delete services.tools;
  if (!webServer) delete services.webServer;
  return { ctx: strictContext(services, registered), registered, services };
}

// A response object that records what a handler wrote.
function stubResponse() {
  const out = { status: 0, headers: {}, body: "" };
  return { out, writeHead: (status, headers) => { out.status = status; out.headers = headers ?? {}; }, end: (body) => { out.body = body === undefined ? "" : String(body); } };
}
const stubRequest = (url, { method = "GET", body = null } = {}) => ({
  url,
  method,
  on(event, handler) {
    if (event === "data" && body) handler(Buffer.from(body));
    if (event === "end") handler();
    return this;
  },
});

// The tools are registered through the harness's own defineTool, which only resolves where
// the harness is installed next to the plugin (dsh/node_modules). The routes never depend on it.
const harnessTools = existsSync(join(ROOT, "dsh", "node_modules", "@deepseek-ai", "dsh-tools"));

test("the plugin registers its routes, and its tools wherever the harness's tools package resolves", async () => {
  assert.equal(name, "gatecraft");
  assert.deepEqual(inject, ["tools", "webServer"]);
  const { ctx, registered } = stubContext();
  const quiet = console.error;
  console.error = () => {};
  try {
    await apply(ctx);
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(registered.tools, harnessTools ? ["gatecraft_compile", "gatecraft_check", "gatecraft_simulate"] : []);
  assert.deepEqual(registered.routes, ["exact /gatecraft/api", "prefix /gatecraft/"]);
  assert.equal(registered.effects.length, 2, "each route's disposer is handed to the context");
  registered.effects.forEach((fn) => fn()());
  assert.deepEqual(registered.routes, [], "disposing unregisters the routes");
});

test("apply never throws: a context that refuses unknown properties, no tools, no web server", async () => {
  // The bug this guards: reading ctx.defineTool threw, the plugin tree failed, and the whole
  // harness would not boot. A plugin reports its own trouble and leaves the host standing.
  const quiet = console.error;
  console.error = () => {};
  try {
    const withoutWeb = stubContext({ webServer: false });
    await apply(withoutWeb.ctx);
    assert.deepEqual(withoutWeb.registered.routes, []);

    const withoutTools = stubContext({ tools: false });
    await apply(withoutTools.ctx);
    assert.deepEqual(withoutTools.registered.tools, []);
    assert.deepEqual(withoutTools.registered.routes, ["exact /gatecraft/api", "prefix /gatecraft/"]);

    const taken = stubContext({ breakRoute: "/gatecraft/api" });
    await apply(taken.ctx);
    assert.deepEqual(taken.registered.routes, ["prefix /gatecraft/"]);

    const hostile = new Proxy({}, { get: (_t, key) => { if (key === "then") return undefined; throw new Error(`cannot get property "${String(key)}" without inject`); } });
    await apply(hostile);
    await apply({});
    await apply(undefined);
  } finally {
    console.error = quiet;
  }
});

test("the agent's tools compile, check and run a circuit", async () => {
  const [compile, check, simulate] = buildTools();
  assert.equal(compile.parameters.program.required, true);

  const built = await compile.execute({ program: VOTE, name: "vote", steps: 2000 }, { signal: { throwIfAborted() {} } });
  assert.deepEqual([built.nand, built.latch, built.rowsChecked, built.wrong, built.examplesHold], [6, 0, 8, 0, 2]);
  assert.match(compile.output.render({}, built)[0].text, /^6 NAND, depth \d+; 8 of 8 rows match the program, and all 2 examples hold\.$/);

  const read = await check.execute({ program: VOTE });
  assert.deepEqual([read.nIn, read.nOut, read.rows, read.examplesHold], [3, 1, 8, 2]);
  assert.equal(read.readback.at(-1), "pass (1 bit) = a plus b plus c is at least 2");
  assert.deepEqual(read.failures, []);

  // a program that contradicts itself is refused, with the failing example named
  const wrong = { ...VOTE, examples: [{ given: { a: 0, b: 0, c: 0 }, expect: { pass: 1 } }] };
  const said = await check.execute({ program: wrong });
  assert.match(said.failures[0], /expected pass=1 but the program gives pass=0/);
  await assert.rejects(compile.execute({ program: wrong, steps: 10 }, {}), /examples do not hold/);

  for (const [inputs, want] of [[[1, 1, 0], 1], [[0, 0, 1], 0], [[1, 0, 1], 1]]) {
    const step = await simulate.execute({ netlistHex: built.netlistHex, nIn: 3, nOut: 1, inputs });
    assert.deepEqual(step.outputs, [want], JSON.stringify(inputs));
  }
  const one = await simulate.execute({ netlistHex: built.netlistHex, nIn: 3, nOut: 1, inputs: [1, 1, 1] });
  assert.equal(simulate.output.render({ inputs: [1, 1, 1] }, one)[0].text, "inputs 111 -> outputs 1");

  // the harness's own defineTool is used when it hands one over
  const wrapped = buildTools({ defineTool: (d) => ({ ...d, wrapped: true }) });
  assert.equal(wrapped.every((t) => t.wrapped), true);
});

test("the plugin's routes answer the API and serve the page", async () => {
  const api = stubResponse();
  await apiRoute(stubRequest("/gatecraft/api", { method: "POST", body: JSON.stringify({ method: "program.run", params: { spec: VOTE, given: { a: 1, b: 1, c: 0 } } }) }), api);
  assert.equal(api.out.status, 200);
  assert.deepEqual(JSON.parse(api.out.body).result, { outputs: { pass: 1 }, next: {} });

  const refused = stubResponse();
  await apiRoute(stubRequest("/gatecraft/api", { method: "GET" }), refused);
  assert.equal(refused.out.status, 405);
  const notJson = stubResponse();
  await apiRoute(stubRequest("/gatecraft/api", { method: "POST", body: "nope" }), notJson);
  assert.equal(notJson.out.status, 400);

  const page = stubResponse();
  await pageRoute(stubRequest("/gatecraft/"), page);
  assert.equal(page.out.status, 200);
  assert.match(page.out.headers["content-type"], /^text\/html/);
  assert.match(page.out.body, /gatecraft/);

  const module = stubResponse();
  await pageRoute(stubRequest("/gatecraft/ui/app.mjs"), module);
  assert.match(module.out.headers["content-type"], /^text\/javascript/);

  const example = stubResponse();
  await pageRoute(stubRequest("/gatecraft/examples/vote.expr.json"), example);
  assert.deepEqual(JSON.parse(example.out.body).inputs, { a: 1, b: 1, c: 1 });

  for (const path of ["/gatecraft/package.json", "/gatecraft/ui/../package.json", "/gatecraft/nope.mjs", "/gatecraft/.git/config"]) {
    const denied = stubResponse();
    await pageRoute(stubRequest(path), denied);
    assert.equal(denied.out.status, 404, path);
  }
});
