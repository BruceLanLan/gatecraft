// anneal-stateful: make an existing NAND + LATCH circuit smaller without
// changing what it does.
//
// A stateful circuit is a function (inputs, state) -> (outputs, next state).
// Each latch's q becomes an extra table input and its d an extra table output;
// that function is annealed against its complete table, laid out again with
// the latches in their original order, and checked on every (input, state)
// pair. Both sides are counted the same way, as NAND elements in the emitted
// netlist, and if the result is not smaller nothing is written (exit code 2).
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { anneal } from "../src/anneal.mjs";
import { writeArtifacts } from "../src/artifacts.mjs";
import { commonOptions, parseCommon, run, summary } from "../src/cli.mjs";
import { COMPILER, defaultSteps, tableDigest } from "../src/compile.mjs";
import { OPCODE } from "../src/netlist.mjs";
import { layout, rebuild } from "../src/rebuild.mjs";
import { seedFromDigest } from "../src/rng.mjs";
import { unwrap } from "../src/stateful.mjs";
import { checkExhaustive, evaluateTable } from "../src/verify.mjs";

const USAGE = `
Usage:
  node scripts/anneal-stateful.mjs <module.mjs> <exportName> --name NAME [--steps S] [--seed S] [--out DIR]

The export is called with no arguments and must return a circuit in the shape
CircuitBuilder.finalize() produces (nIn, nOut, outputs, elements). Exits 2 and
writes nothing when annealing does not make the circuit smaller.
`;

run(USAGE, async () => {
  const { values, positionals } = parseArgs({ options: commonOptions, allowPositionals: true });
  const [modulePath, exportName] = positionals;
  if (!modulePath || !exportName) throw new Error("give a module path and an export name (see --help)");
  const opts = parseCommon(values);
  const mod = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof mod[exportName] !== "function") throw new Error(`${basename(modulePath)} has no exported function ${exportName}`);
  const original = mod[exportName]();

  const ys = evaluateTable(original);
  const net = unwrap(original);
  const table = { nIn: net.nIn, nState: net.nLatch, nOut: net.nOut, ys };
  const digest = tableDigest(table);
  const seed = opts.seed ?? seedFromDigest(digest);
  const before = original.elements.filter((e) => e.op === OPCODE.NAND).length;
  const bits = net.nIn + net.nLatch;
  const layoutOnly = layout({ nIn: bits, gates: net.gates, outputs: net.outputs, nOut: net.nOut }).total;

  const steps = opts.steps ?? defaultSteps(net.gates.length, ys.length);
  const annealed = anneal({ nIn: bits, gates: net.gates, outputs: net.outputs, nOut: net.nOut }, ys, { steps, seed });
  const circuit = rebuild({ nIn: net.nIn, nLatch: net.nLatch, gates: annealed.gates, outputs: annealed.outputs, nOut: net.nOut });
  const check = checkExhaustive(circuit, ys);
  if (!check.exact) throw new Error(`internal: rewrapped circuit differs on ${check.wrong} rows; nothing written`);
  if (circuit.nNand >= before) {
    console.error(`${opts.name}: not smaller (${before} NAND before, ${circuit.nNand} after, ${net.nLatch} LATCH either way); nothing written`);
    return 2;
  }

  const certificate = {
    compiler: COMPILER,
    source: { module: basename(modulePath), export: exportName },
    table: { sha256: digest, nIn: net.nIn, nState: net.nLatch, nOut: net.nOut, rows: ys.length },
    reproduce: { seed, steps: annealed.stats.steps },
    minimisation: { nandBefore: before, nandAfterLayoutOnly: layoutOnly, nandAfter: circuit.nNand, latch: net.nLatch, stateBits: "latch order unchanged" },
    circuit: {
      nand: circuit.nNand,
      latch: circuit.nLatch,
      depth: circuit.depth,
      podCost: circuit.podCost,
      netlistBytes: circuit.netlistBytes,
      netlistSha256: createHash("sha256").update(circuit.netlist).digest("hex"),
      bufferedOutputs: circuit.layout.bufferedOutputs,
    },
    verification: { rowsChecked: check.rows, wrong: check.wrong, methods: check.methods, outputsInTail: true, refs: 0 },
  };
  summary(opts.name, { circuit, certificate }, writeArtifacts(opts.out, opts.name, { circuit, certificate, table }));
  console.log(`  ${before} NAND before -> ${circuit.nNand} after (layout alone: ${layoutOnly})`);
  return 0;
});
