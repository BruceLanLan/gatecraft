#!/usr/bin/env node
// Compile behaviour written as expressions over named, sized inputs.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { writeArtifacts } from "../src/artifacts.mjs";
import { commonOptions, parseCommon, run, summary } from "../src/cli.mjs";
import { compileSpec } from "../src/job.mjs";

const USAGE = `
Usage:
  node scripts/compile-expr.mjs --spec spec.json --name NAME

spec.json names the inputs and their widths, optional shared definitions, and the outputs,
each with a width and an expression:

  {
    "inputs":  { "a": 8, "b": 8 },
    "let":     { "total": "a + b" },
    "outputs": { "sum":  { "width": 9, "expr": "total" },
                 "big":  { "width": 1, "expr": "total > 200" } },
    "examples": [ { "given": { "a": 150, "b": 100 }, "expect": { "sum": 250, "big": 1 } } ]
  }

Values are exact integers and each output is its value modulo 2^width. Operators follow
JavaScript: ?: || && | ^ & == != < <= > >= << >> >>> + - * / %, unary ~ ! -, and bit slices
a[3] and a[7:4]. Inputs are packed least significant bit first in declaration order; the
certificate lists which bits each name occupies. Inputs total at most 20 bits.
Examples are optional; every one is checked first, and if any does not hold nothing is compiled.

Options:
  --steps S   annealing budget in steps (default: depends on the table's size)
  --seed S    random seed (default: derived from the table, so reruns match)
  --objective gates|cost
              what annealing minimises: NAND count (default) or PoD cost
  --out DIR   output directory (default out/NAME)
`;

run(USAGE, () => {
  const { values } = parseArgs({ options: { ...commonOptions, spec: { type: "string" } } });
  const opts = parseCommon(values);
  if (!values.spec) throw new Error("give --spec FILE (see --help)");
  const result = compileSpec("expr", JSON.parse(readFileSync(values.spec, "utf8")), opts);
  const c = result.certificate;
  summary(opts.name, result, writeArtifacts(opts.out, opts.name, result));
  const cands = c.synthesis.startsConsidered.map((s) => `${s.frontEnd} ${s.nand}${s.exact ? "" : " (inexact, dropped)"}`).join(", ");
  console.log(`  started from ${c.synthesis.frontEnd} (${cands} NAND before annealing)`);
});
