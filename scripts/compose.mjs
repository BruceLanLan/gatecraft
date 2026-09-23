#!/usr/bin/env node
// Compile a program too wide for one proof as blocks that each get one, joined by REF.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { commonOptions, parseCommon, run } from "../src/cli.mjs";
import { composeSpec, composedFiles } from "../src/job.mjs";

const USAGE = `
Usage:
  node scripts/compose.mjs --spec spec.json --name NAME

The spec is the same expression program compile-expr.mjs takes, but its inputs and state
may add up to more than 20 bits. It is cut at its names: each state's "next", each output
and each "let" that fits on a wire becomes its own combinational block, proven on every row
of its own table. No single name may read more than 20 bits; name a piece of it with "let"
if it does. Identical blocks are compiled once and used from every place they are needed.

Two deliveries are written, and which to use is yours:
  top.netlist.json     one circuit of latches and REFs, no logic: link it with --link once
                       the blocks are deployed, and it runs as one circuit on the chain.
  replay.json          the blocks and the order to run them in, for a caller that keeps
                       the state itself and never uses REF.

Options:
  --steps S     annealing budget per block (default: depends on each block's size)
  --seed S      random seed (default: derived from each block's table)
  --objective gates|cost
  --out DIR     output directory (default out/NAME)
`;

run(USAGE, () => {
  const { values } = parseArgs({ options: { ...commonOptions, spec: { type: "string" } } });
  const opts = parseCommon(values);
  if (!values.spec) throw new Error("give --spec FILE (see --help)");
  const result = composeSpec(JSON.parse(readFileSync(values.spec, "utf8")), opts);
  const c = result.certificate;
  mkdirSync(opts.out, { recursive: true });
  const files = composedFiles(opts.name, result);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(opts.out, file), text);
  console.log(`${opts.name}: ${c.program.bits} bits of input and state, cut into ${result.refs.length} parts sharing ${result.blocks.length} block${result.blocks.length === 1 ? "" : "s"}`);
  for (const b of c.blocks) {
    const uses = b.computes.map((u) => `${u.name}(${u.reads.join(",")})`).join(" ");
    console.log(`  block ${b.index}: ${b.nIn} -> ${b.nOut} bits, ${b.nand} NAND, ${b.rowsChecked}/${b.rowsChecked} rows exact; computes ${uses}`);
  }
  console.log(`  top: ${c.top.latch} LATCH + ${c.top.refs} REF, 0 NAND, ${c.top.netlistBytes} bytes; ${c.verification.nandTotal} NAND in all`);
  console.log(`  end to end: ${c.verification.endToEnd.rows} rows (${c.verification.endToEnd.exhaustive ? "every row" : `${c.verification.endToEnd.examples} examples + sampled`}) agree between the linked circuit, the replay and the program`);
  if (c.inlined.length) console.log(`  kept inside the blocks that read them (can go negative): ${c.inlined.join(", ")}`);
  console.log(`  -> ${opts.out}/ (${Object.keys(files).length} files)`);
});
