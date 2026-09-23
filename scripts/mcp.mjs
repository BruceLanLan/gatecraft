#!/usr/bin/env node
// gatecraft as an MCP server over stdio, for an agent the person already has.
//
//   claude mcp add gatecraft -- node /path/to/gatecraft/scripts/mcp.mjs --out ./gatecraft-out
//
// stdout carries protocol messages and nothing else; anything meant for a human goes to stderr.
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createGatecraftMcp } from "../src/mcp.mjs";
import { decisionKey } from "../src/decisionkey.mjs";

const { values } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  process.stderr.write(`gatecraft MCP server (stdio)

  node scripts/mcp.mjs [--out DIR]

--out  where decision bundles are written (default: ./gatecraft-out in the directory the agent
       starts this in). Nothing is written anywhere else.

The decision model's key, if you use with="jev", is read from $TYPESAFE_API_KEY or
~/.config/gatecraft/jev.token. It is never returned to the agent.
`);
  process.exit(0);
}

const server = createGatecraftMcp({ outRoot: resolve(values.out ?? process.env.GATECRAFT_OUT ?? "gatecraft-out"), key: decisionKey });
const send = (message) => { if (message) process.stdout.write(`${JSON.stringify(message)}\n`); };

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve();
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "that line is not JSON" } }); return; }
  // Answer in order: a client that pipelines calls gets replies in the order it asked.
  pending = pending.then(() => server.handle(message)).then(send, (error) => {
    process.stderr.write(`gatecraft mcp: ${error?.stack ?? error}\n`);
    if (message?.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
  });
});
lines.on("close", () => { pending.then(() => process.exit(0)); });
process.stderr.write(`gatecraft mcp: ready, bundles under ${server.root}\n`);
