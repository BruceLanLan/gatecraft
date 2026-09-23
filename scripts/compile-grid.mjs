// compile-grid: a 16x16 decision grid in, a proven 8-in / 2-out circuit out.
//
// Inputs are two 4-bit numbers, X on input bits 0-3 and Y on bits 4-7; the
// output is a choice 0..3 on two bits. The certificate records how often each
// choice occurs and which choices the circuit can never make.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { writeArtifacts } from "../src/artifacts.mjs";
import { commonOptions, parseCommon, run, summary } from "../src/cli.mjs";
import { compileSpec } from "../src/job.mjs";

const USAGE = `
Usage:
  node scripts/compile-grid.mjs --map grid.json --name NAME
  node scripts/compile-grid.mjs --fn "<expression in x, y giving 0..3>" --name NAME

grid.json is a 16x16 array of choices 0..3: row X, column Y.

Options:
  --labels a,b,c,d   names for choices 0..3, used in the certificate
  --steps S          annealing budget in steps (default 200000)
  --seed S           random seed (default: derived from the grid, so reruns match)
  --objective gates|cost
                     what annealing minimises: NAND count (default) or PoD cost
  --out DIR          output directory (default out/NAME)
`;

run(USAGE, () => {
  const { values } = parseArgs({ options: { ...commonOptions, map: { type: "string" }, fn: { type: "string" }, labels: { type: "string" } } });
  const opts = parseCommon(values);
  const labels = values.labels ? values.labels.split(",").map((s) => s.trim()) : ["0", "1", "2", "3"];
  if (labels.length !== 4 || labels.some((s) => !s)) throw new Error("--labels needs four comma-separated names");
  let spec;
  if (values.map) spec = { map: JSON.parse(readFileSync(values.map, "utf8")) };
  else if (values.fn !== undefined) spec = { fn: values.fn };
  else throw new Error("give --map FILE or --fn EXPRESSION (see --help)");
  const result = compileSpec("grid", spec, { ...opts, labels });
  summary(opts.name, result, writeArtifacts(opts.out, opts.name, result));
  const never = result.certificate.grid.neverChosen;
  console.log(`  choices: ${labels.map((l, k) => `${l} ${result.counts[k]}`).join(" / ")}${never.length ? `; never chosen: ${never.join(", ")}` : ""}`);
});
