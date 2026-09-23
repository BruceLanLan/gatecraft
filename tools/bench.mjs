// A fixed set of tables, compiled with fixed seeds, so a change to the synthesizer or the
// annealer can be judged by numbers rather than by one example. Every result is checked
// on every row by compileTable itself; this script only records what it reports.
//
//   node tools/bench.mjs                 all tables
//   node tools/bench.mjs mul6 rand12x4   only those
//   node tools/bench.mjs --json          one JSON object per line
//
// Columns: synthesized NAND (before annealing), final NAND, depth, annealing steps actually
// used, seconds. Wide tables get few or no annealing steps by design, so for them the
// synthesized count is the final count and the synthesizer alone decides the result.
import { compileTable } from "../src/compile.mjs";
import { compileSpec } from "../src/job.mjs";
import { combinationalTable } from "../src/tables.mjs";

const mask = (bits) => 2 ** bits - 1;

// Deterministic pseudo-random tables: the benchmark must not change between runs.
function randomTable(nIn, nOut, seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  const ys = new Uint32Array(2 ** nIn);
  for (let i = 0; i < ys.length; i++) ys[i] = next() & mask(nOut);
  return { nIn, nState: 0, nOut, ys };
}

const fnTable = (nIn, nOut, fn) => Object.assign(combinationalTable({ nIn, nOut, fn }), { spec: { nIn, nOut, fn } });
const half = (n) => `(x & ${mask(n)})`;
const high = (n) => `(x >>> ${n})`;

export const TABLES = {
  majority3: () => fnTable(3, 1, "((x&1)+((x>>1)&1)+((x>>2)&1)) >= 2 ? 1 : 0"),
  parity8: () => fnTable(8, 1, "(()=>{let v=x,p=0;while(v){p^=v&1;v>>>=1}return p})()"),
  adder4: () => fnTable(8, 5, `${half(4)} + ${high(4)}`),
  adder8: () => fnTable(16, 9, `${half(8)} + ${high(8)}`),
  adder10: () => fnTable(20, 11, `${half(10)} + ${high(10)}`),
  cmp10: () => fnTable(20, 1, `${half(10)} < ${high(10)} ? 1 : 0`),
  mux16: () => fnTable(20, 1, "(x >>> (4 + (x & 15))) & 1"),
  popcount12: () => fnTable(12, 4, "(()=>{let v=x,c=0;while(v){c+=v&1;v>>>=1}return c})()"),
  mul3: () => fnTable(6, 6, `${half(3)} * ${high(3)}`),
  mul4: () => fnTable(8, 8, `${half(4)} * ${high(4)}`),
  mul5: () => fnTable(10, 10, `${half(5)} * ${high(5)}`),
  mul6: () => fnTable(12, 12, `${half(6)} * ${high(6)}`),
  rand6x6: () => randomTable(6, 6, 1),
  rand8x8: () => randomTable(8, 8, 2),
  rand10x4: () => randomTable(10, 4, 3),
  rand12x2: () => randomTable(12, 2, 4),
};

const argv = import.meta.url === `file://${process.argv[1]}` ? process.argv.slice(2) : null;
if (argv) {
const json = argv.includes("--json");
const wanted = argv.filter((a) => !a.startsWith("--"));
const names = wanted.length ? wanted : Object.keys(TABLES);

if (!json) console.log(["table", "in", "out", "synth", "final", "depth", "steps", "sec", "from"].map((h) => h.padStart(h === "table" ? 11 : 7)).join(""));
let totalSynth = 0, totalFinal = 0;
for (const name of names) {
  if (!TABLES[name]) throw new Error(`no such table: ${name}`);
  const table = TABLES[name]();
  const t0 = performance.now();
  const { circuit, certificate } = table.spec ? compileSpec("table", table.spec, { seed: 1 }) : compileTable(table, { seed: 1 });
  const sec = (performance.now() - t0) / 1000;
  const row = {
    table: name, nIn: table.nIn, nOut: table.nOut,
    synth: certificate.synthesis.nandAfterSynthesis, final: circuit.nNand, depth: circuit.depth,
    steps: certificate.reproduce.steps, sec: +sec.toFixed(2), from: certificate.synthesis.frontEnd ?? "bdd",
  };
  totalSynth += row.synth; totalFinal += row.final;
  if (json) console.log(JSON.stringify(row));
  else console.log([row.table.padStart(11), ...[row.nIn, row.nOut, row.synth, row.final, row.depth, row.steps, row.sec, row.from].map((v) => String(v).padStart(7))].join(""));
}
if (!json) console.log(`${"total".padStart(11)}${"".padStart(14)}${String(totalSynth).padStart(7)}${String(totalFinal).padStart(7)}`);
}
