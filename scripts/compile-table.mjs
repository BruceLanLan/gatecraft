// compile-table: a complete truth table in, a proven NAND circuit out.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { writeArtifacts } from "../src/artifacts.mjs";
import { commonOptions, parseCommon, parseCount, run, summary } from "../src/cli.mjs";
import { compileSpec } from "../src/job.mjs";

const USAGE = `
Usage:
  node scripts/compile-table.mjs --fn "<expression in x>" --nIn N --nOut M --name NAME
  node scripts/compile-table.mjs --table table.json --name NAME

table.json is {"nIn": N, "nOut": M, "rows": [[x, y], ...]} listing all 2^N inputs
(bits packed LSB first), or {"nIn": N, "nOut": M, "fn": "<expression in x>"}.

Options:
  --steps S   annealing budget in steps (default 200000)
  --seed S    random seed (default: derived from the table, so reruns match)
  --objective gates|cost
              what annealing minimises: NAND count (default) or PoD cost
  --out DIR   output directory (default out/NAME)
`;

run(USAGE, () => {
  const { values } = parseArgs({
    options: { ...commonOptions, fn: { type: "string" }, table: { type: "string" }, nIn: { type: "string" }, nOut: { type: "string" } },
  });
  const opts = parseCommon(values);
  let spec;
  if (values.table) spec = JSON.parse(readFileSync(values.table, "utf8"));
  else if (values.fn !== undefined) spec = { nIn: parseCount(values.nIn, "--nIn"), nOut: parseCount(values.nOut, "--nOut"), fn: values.fn };
  else throw new Error("give --table FILE, or --fn with --nIn and --nOut (see --help)");
  const result = compileSpec("table", spec, opts);
  summary(opts.name, result, writeArtifacts(opts.out, opts.name, result));
});
