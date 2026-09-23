// compile-fsm: a state transition table in, a proven NAND + LATCH circuit out.
//
// Every (input, state) pair lists its output and next state. The state lives in
// nState latches (state bit i is latch i, in declaration order), and the
// circuit is checked on every (input, state) pair: outputs and next state.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { writeArtifacts } from "../src/artifacts.mjs";
import { commonOptions, parseCommon, parseCount, run, summary } from "../src/cli.mjs";
import { compileSpec } from "../src/job.mjs";

const USAGE = `
Usage:
  node scripts/compile-fsm.mjs --spec fsm.json --name NAME
  node scripts/compile-fsm.mjs --fn "<expression in x, s returning [y, next]>" --nIn N --nState K --nOut M --name NAME

fsm.json is {"nIn": N, "nState": K, "nOut": M, "rows": [[x, s, y, next], ...]}
listing every (input, state) pair, or the same shape with "fn" instead of "rows".
Inputs plus state must be at most 20 bits. The certificate lists the states
reachable from state 0 (all latches clear).

Options:
  --steps S   annealing budget in steps (default 200000)
  --seed S    random seed (default: derived from the table, so reruns match)
  --objective gates|cost
              what annealing minimises: NAND count (default) or PoD cost
  --out DIR   output directory (default out/NAME)
`;

run(USAGE, () => {
  const { values } = parseArgs({
    options: { ...commonOptions, spec: { type: "string" }, fn: { type: "string" }, nIn: { type: "string" }, nState: { type: "string" }, nOut: { type: "string" } },
  });
  const opts = parseCommon(values);
  let spec;
  if (values.spec) spec = JSON.parse(readFileSync(values.spec, "utf8"));
  else if (values.fn !== undefined) {
    spec = { nIn: parseCount(values.nIn, "--nIn"), nState: parseCount(values.nState, "--nState"), nOut: parseCount(values.nOut, "--nOut"), fn: values.fn };
  } else throw new Error("give --spec FILE, or --fn with --nIn, --nState and --nOut (see --help)");
  const result = compileSpec("fsm", spec, opts);
  summary(opts.name, result, writeArtifacts(opts.out, opts.name, result));
  console.log(`  states reachable from 0: ${result.reachable.length} of ${2 ** result.table.nState}`);
});
