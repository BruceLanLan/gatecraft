// ui: serve the browser interface on this machine and print its address.
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { parseCount, run } from "../src/cli.mjs";
import { loadApiPlugins, pluginDir, pluginsInDir } from "../src/plugins.mjs";
import { startUiServer } from "../src/ui-server.mjs";

const USAGE = `
Usage:
  node scripts/ui.mjs [--port N] [--token TOKEN] [--no-api]

Serves the browser interface on 127.0.0.1 only (default port 4747; 0 picks a
free port). Compiling runs inside the page. The page talks to nothing except
this server and, when you build a tape-out plan, the RPC address you type in.
Stop with Ctrl-C.

The same address answers a local API for other programs on this machine:

  curl -s localhost:4747/api                                   # what it answers
  curl -s localhost:4747/api -d '{"method":"program.check","params":{"spec":SPEC}}'
  curl -s localhost:4747/api -d '{"method":"compile.expr","params":{"spec":SPEC}}'

where SPEC is an expression program, the same JSON compile-expr takes.

Your own methods and routes go in plugins: every *.mjs in
~/.config/gatecraft/api-plugins/ is loaded, plus any --plugin FILE. A plugin
exports a name and an apply(ctx); see src/plugins.mjs for the shape.

Options:
  --token TOKEN  require it as "authorization: Bearer TOKEN" on /api and on plugin routes
  --plugin FILE  load this plugin too (repeatable)
  --no-plugins   skip the plugin directory and any --plugin
  --no-api       serve the page only
`;

run(USAGE, async () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      token: { type: "string" },
      plugin: { type: "string", multiple: true, default: [] },
      "no-plugins": { type: "boolean" },
      "no-api": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const port = values.port === undefined ? 4747 : parseCount(values.port, "--port", { max: 65535 });
  const dir = pluginDir(homedir());
  const files = values["no-plugins"] ? [] : [...(await pluginsInDir(dir)), ...values.plugin];
  const added = files.length ? await loadApiPlugins(files) : null;
  const server = await startUiServer({ port, apiToken: values.token ?? null, api: !values["no-api"], added });
  console.log(`gatecraft UI: ${server.url}`);
  if (server.api) console.log(`gatecraft API: ${server.api}${values.token ? " (token required)" : ""}`);
  for (const p of added?.plugins ?? []) {
    console.log(`  plugin ${p.name}: ${[...p.methods, ...p.routes].join(", ") || "(nothing registered)"}`);
  }
  if (!files.length && !values["no-plugins"]) console.log(`  (no plugins; drop a *.mjs into ${dir} to add your own methods)`);
});
