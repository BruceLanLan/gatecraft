// Adding your own API without touching this checkout, the way the local tooling on this
// machine does it: a plugin is a module that exports a name and an apply(ctx), and registers
// what it adds through ctx. One that fails to load, or to register one thing, is logged and
// skipped - it never takes the server with it.
//
//   // ~/.config/gatecraft/api-plugins/cost.mjs
//   export const name = "cost";
//   export function apply(ctx) {
//     ctx.method("of", ({ netlist }) => ({ podCost: netlist.nand * netlist.depth ** 3 }));
//     ctx.route("/cost/health", "GET", (req, res) => { res.writeHead(200); res.end("ok\n"); });
//     ctx.effect(() => console.log("cost: gone"));
//   }
//
// The method above answers POST /api as "cost.of": a plugin's methods always sit under its
// own name, so an added method can never shadow a built-in one or another plugin's. Its
// routes must likewise live under /<name>/. Everything a plugin adds is behind the same
// fence as the rest of the server: loopback, a checked Host, no cross-site request.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError, METHODS } from "./api.mjs";

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const ACTION = /^[a-z][a-zA-Z0-9]{0,30}$/;
const ROUTE_METHODS = new Set(["GET", "POST"]);

// The directory a person drops plugins into, so nothing has to be passed on the command line.
export const pluginDir = (home) => join(home, ".config", "gatecraft", "api-plugins");

export async function pluginsInDir(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".mjs")).map((e) => join(dir, e.name)).sort();
  } catch {
    return []; // no directory, no plugins
  }
}

// Loads each plugin file and returns what they added:
//   { methods: { "name.action": handler }, routes: [{ path, method, handler, plugin }],
//     plugins: [{ name, file, methods, routes }], problems: [string], dispose() }
export async function loadApiPlugins(files, { log = console.error, builtins = METHODS } = {}) {
  const methods = {};
  const routes = [];
  const plugins = [];
  const problems = [];
  const disposers = [];
  const complain = (message) => {
    problems.push(message);
    log(`gatecraft: ${message}`);
  };

  for (const file of files) {
    let module;
    try {
      module = await import(pathToFileURL(file).href);
    } catch (error) {
      complain(`plugin ${file} did not load: ${error.message}`);
      continue;
    }
    const name = module.name;
    if (typeof name !== "string" || !NAME.test(name)) {
      complain(`plugin ${file} needs an exported name of lowercase letters, digits and dashes`);
      continue;
    }
    if (plugins.some((p) => p.name === name)) {
      complain(`plugin ${file} calls itself "${name}", which another plugin already registered`);
      continue;
    }
    if (typeof module.apply !== "function") {
      complain(`plugin ${name} (${file}) exports no apply(ctx)`);
      continue;
    }
    const mine = { name, file, methods: [], routes: [] };
    const ctx = {
      name,
      // The built-in methods, to read and to call; a plugin can build on them.
      api: builtins,
      ApiError,
      log: (...args) => log(`gatecraft ${name}:`, ...args),
      method(action, handler) {
        if (typeof action !== "string" || !ACTION.test(action)) throw new Error(`method name ${JSON.stringify(action)} must be lowercase-ish letters and digits`);
        if (typeof handler !== "function") throw new Error(`method ${name}.${action} needs a function`);
        const full = `${name}.${action}`;
        if (full in builtins || full in methods) throw new Error(`method ${full} is already registered`);
        methods[full] = handler;
        mine.methods.push(full);
        return full;
      },
      route(path, method, handler) {
        const verb = String(method ?? "GET").toUpperCase();
        if (typeof path !== "string" || !path.startsWith(`/${name}/`)) throw new Error(`route ${JSON.stringify(path)} must start with "/${name}/"`);
        if (!ROUTE_METHODS.has(verb)) throw new Error(`route ${path} must be GET or POST`);
        if (typeof handler !== "function") throw new Error(`route ${path} needs a handler function`);
        if (routes.some((r) => r.path === path && r.method === verb)) throw new Error(`route ${verb} ${path} is already registered`);
        const entry = { path, method: verb, handler, plugin: name };
        routes.push(entry);
        mine.routes.push(`${verb} ${path}`);
        return () => {
          const at = routes.indexOf(entry);
          if (at >= 0) routes.splice(at, 1);
        };
      },
      effect(fn) {
        if (typeof fn === "function") disposers.push(fn);
      },
    };
    try {
      await module.apply(ctx);
    } catch (error) {
      complain(`plugin ${name} failed while registering: ${error.message}`);
    }
    if (!mine.methods.length && !mine.routes.length) complain(`plugin ${name} registered nothing`);
    plugins.push(mine);
  }

  return {
    methods,
    routes,
    plugins,
    problems,
    async dispose() {
      for (const fn of disposers.reverse()) {
        try {
          await fn();
        } catch (error) {
          log(`gatecraft: a plugin's cleanup failed: ${error.message}`);
        }
      }
      disposers.length = 0;
    },
  };
}
