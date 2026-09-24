// The pipeline behind every front end: a complete table in, a laid-out and
// exhaustively verified circuit with its certificate out.
//
//   table -> synthesize (shared ROBDD -> NAND) -> anneal (size only, exactness
//   kept) -> rebuild (output tail, latches) -> check every (input, state) row
//
// A table has nIn input bits, nState latch bits and nOut output bits. Row
// x | state << nIn holds outputs | nextState << nOut. A combinational table
// has nState = 0.
import { anneal } from "./anneal.mjs";
import { layout, rebuild } from "./rebuild.mjs";
import { createRng, seedFromDigest } from "./rng.mjs";
import { sha256 } from "./sha256.mjs";
import { synthesize } from "./synth.mjs";
import { checkExhaustive, MAX_BITS } from "./verify.mjs";

export const COMPILER = "gatecraft 0.7.0";
export const DEFAULT_STEPS = 200_000;
// What annealing minimises: "gates" (the NAND count, the default) or "cost",
// the PoD cost, which weighs depth cubed. A certificate without
// reproduce.objective was annealed for gates.
export const OBJECTIVES = ["gates", "cost"];
const WORK_BUDGET = 4e10;

// The budget is still expressed as (gates x rows / 32) word operations a step, the cost of
// recomputing every gate, so very large tables get proportionally fewer default steps, down
// to none: the synthesized circuit is already exact, annealing only shrinks it. A step no
// longer costs that much — it evaluates only the rewired gate's fan-out, stops at the first
// wrong output, and on wide tables tries the move on a sample of rows first, 20 to 33 times
// faster on the widest tables measured — so the budget is twenty times what it was, which
// spends the saving on searching rather than on finishing sooner. The count used is recorded
// in the certificate; passing it back as `steps` reproduces the run.
//
// Past 16 table bits the budget shrinks with the table. There, a step that keeps the circuit
// exact still has to be verified on every row — the sampled first look only speeds up the
// steps that break it — and small netlists over wide tables keep a good share of their
// steps exact: a 20-bit comparator measured 12-21%, at about 1.7 ms a step. The full budget
// there took it from 101 to 76 NAND but from 2.4 s to 17 s, so the default keeps wide
// tables near their old compile time and `steps` buys the rest for anyone who wants it.
const FULL_BUDGET_WORDS = 2048; // 16 table bits

export function defaultSteps(gateCount, rows) {
  const words = Math.ceil(rows / 32);
  const perStep = Math.max(1, gateCount) * words;
  const budget = WORK_BUDGET * Math.min(1, FULL_BUDGET_WORDS / words);
  return Math.min(DEFAULT_STEPS, Math.floor(budget / perStep));
}

export function validateTable({ nIn, nState = 0, nOut, ys }) {
  const bits = nIn + nState;
  if (!Number.isInteger(nIn) || nIn < 0) throw new Error("nIn must be a non-negative integer");
  if (!Number.isInteger(nState) || nState < 0) throw new Error("nState must be a non-negative integer");
  if (!Number.isInteger(nOut) || nOut < 1) throw new Error("nOut must be at least 1");
  if (bits < 1 || bits > MAX_BITS) throw new Error(`inputs plus state must be 1..${MAX_BITS} bits (got ${bits}); split larger behaviour into several circuits`);
  if (nOut + nState > 32) throw new Error("outputs plus state must fit in 32 bits");
  if (!(ys instanceof Uint32Array) || ys.length !== 2 ** bits) throw new Error(`the table needs all ${2 ** bits} rows`);
  const limit = 2 ** (nOut + nState);
  for (let r = 0; r < ys.length; r++) {
    if (ys[r] >= limit) throw new Error(`row ${r} has value ${ys[r]}, which does not fit in ${nOut + nState} bits`);
  }
}

// Digest of the table itself: shape header, then every row as a little-endian
// uint32. Independent of the machine it runs on.
export function tableDigest({ nIn, nState = 0, nOut, ys }) {
  const body = new Uint8Array(ys.length * 4);
  const view = new DataView(body.buffer);
  ys.forEach((y, r) => view.setUint32(r * 4, y, true));
  return sha256(`gatecraft-table/1 nIn=${nIn} nState=${nState} nOut=${nOut}\n`, body);
}

// A starting netlist is scored the way the chosen objective scores the finished circuit.
function scoreStart({ nIn, nState, nOut, gates, outputs, ys, objective }) {
  const circuit = rebuild({ nIn, nLatch: nState, gates, outputs, nOut });
  const check = checkExhaustive(circuit, ys);
  return { exact: check.exact, nand: circuit.nNand, score: objective === "cost" ? circuit.podCost : circuit.nNand };
}

// onProgress, if given, hears { phase: "synthesis" | "annealing" | "verification",
// step, steps }; it only observes and never changes the result.
//
// `candidates`, if given, are other starting netlists for the same table - { frontEnd, gates,
// outputs } in the synthesizer's signal numbering - such as a structural compilation of the
// expression the table came from. Each is checked on every row first; an inexact one is
// recorded and dropped, never annealed. The best exact start by the objective is annealed,
// so a candidate can only make the result smaller, never wrong.
export function compileTable(table, { steps, seed, objective = "gates", onProgress, candidates = [] } = {}) {
  validateTable(table);
  if (!OBJECTIVES.includes(objective)) throw new Error("objective must be gates or cost");
  const { nIn, nState = 0, nOut, ys } = table;
  const bits = nIn + nState;
  const digest = tableDigest(table);
  const usedSeed = seed ?? seedFromDigest(digest);
  const rng = createRng(usedSeed);
  const report = onProgress ?? (() => {});

  report({ phase: "synthesis", step: 0, steps: 0 });
  const synth = synthesize({ nIn: bits, ys, nOutputs: nOut + nState }, { rng });
  let start = { frontEnd: "bdd", gates: synth.gates, outputs: synth.outputs };
  const considered = [];
  if (candidates.length) {
    const bdd = scoreStart({ nIn, nState, nOut, gates: synth.gates, outputs: synth.outputs, ys, objective });
    considered.push({ frontEnd: "bdd", nand: bdd.nand, exact: true });
    let best = bdd.score;
    for (const c of candidates) {
      const s = scoreStart({ nIn, nState, nOut, gates: c.gates, outputs: c.outputs, ys, objective });
      considered.push({ frontEnd: c.frontEnd, nand: s.nand, exact: s.exact });
      if (s.exact && s.score < best) {
        best = s.score;
        start = { frontEnd: c.frontEnd, gates: c.gates, outputs: c.outputs };
      }
    }
  }
  const afterSynthesis = layout({ nIn: bits, gates: start.gates, outputs: start.outputs, nOut }).total;
  const annealSteps = steps ?? defaultSteps(start.gates.length, ys.length);
  const annealed = anneal({ nIn: bits, gates: start.gates, outputs: start.outputs, nOut }, ys, {
    steps: annealSteps,
    seed: Math.floor(rng() * 4294967296) >>> 0,
    objective: objective === "cost" ? "C" : "gates",
    onProgress: (step) => report({ phase: "annealing", step, steps: annealSteps }),
  });
  report({ phase: "verification", step: 0, steps: 0 });
  const circuit = rebuild({ nIn, nLatch: nState, gates: annealed.gates, outputs: annealed.outputs, nOut });
  const check = checkExhaustive(circuit, ys);
  if (!check.exact) throw new Error(`rebuilt circuit disagrees with the table on ${check.wrong} rows; nothing emitted`);

  const certificate = {
    compiler: COMPILER,
    table: { sha256: digest, nIn, nState, nOut, rows: ys.length },
    reproduce: { seed: usedSeed, steps: annealed.stats.steps, ...(objective === "cost" ? { objective } : {}) },
    synthesis: {
      bddNodes: synth.bddNodes,
      bddOrdersTried: synth.ordersTried,
      sifted: synth.sifted,
      variableOrder: synth.variableOrder,
      nandAfterSynthesis: afterSynthesis,
      nandAfterAnnealing: annealed.total,
      ...(considered.length ? { frontEnd: start.frontEnd, startsConsidered: considered } : {}),
    },
    circuit: {
      nand: circuit.nNand,
      latch: circuit.nLatch,
      depth: circuit.depth,
      podCost: circuit.podCost,
      netlistBytes: circuit.netlistBytes,
      netlistSha256: sha256(circuit.netlist),
      bufferedOutputs: circuit.layout.bufferedOutputs,
    },
    verification: { rowsChecked: check.rows, wrong: check.wrong, methods: check.methods, outputsInTail: true, refs: 0 },
  };
  return { circuit, certificate };
}
