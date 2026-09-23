// The annealer as it was before incremental evaluation: every step recomputes every gate
// above the one it changed. Kept verbatim so the incremental one can be held to producing
// byte-identical netlists — the search makes the same decisions, it only stops redoing work.

// Equivalence-preserving minimisation of a flat NAND netlist by simulated
// annealing.
//
// Exactness over the whole table is a hard constraint, never a penalty: every
// state the search visits computes the same function as the input. What is
// annealed is size, measured by layout() from rebuild.mjs (live gates plus the
// buffers the output tail needs), so the number minimised here is exactly the
// number of NANDs the rebuilt circuit will have. A rewire that keeps the
// circuit exact but makes it bigger is accepted with probability exp(-d / T),
// which is how the search leaves plateaus that no single shrinking move
// escapes.
//
// Every random choice comes from a seeded generator and the budget is a number
// of steps, not seconds, so the same netlist, table, seed and step count
// always give the same result on any machine.
import { layout } from "../src/rebuild.mjs";
import { createRng } from "../src/rng.mjs";

// net: { nIn, gates, outputs, nOut } where nIn counts every table bit (inputs
// and, for a stateful circuit, the latch outputs) and the first nOut outputs
// are the ones that must end up in the output tail.
// onProgress(step), if given, is called every 4096 steps and draws no random numbers.
export function anneal(net, ys, { steps = 200_000, seed = 1, reheats = 6, t0 = 3, t1 = 0.1, objective = "gates", greedy = false, onProgress } = {}) {
  if (!["gates", "C"].includes(objective)) throw new Error("objective must be gates or C");
  const { nIn, nOut } = net;
  const gate0 = 2 + nIn;
  const G = net.gates.length;
  const NOUT = net.outputs.length;
  const R = ys.length;
  if (R !== 2 ** nIn) throw new Error(`table has ${R} rows, expected ${2 ** nIn}`);
  const W = Math.ceil(R / 32);
  const rng = createRng(seed);

  const SIG = new Array(gate0 + G);
  SIG[0] = new Uint32Array(W);
  SIG[1] = new Uint32Array(W).fill(0xffffffff);
  for (let i = 0; i < nIn; i++) SIG[2 + i] = new Uint32Array(W);
  for (let i = 0; i < G; i++) SIG[gate0 + i] = new Uint32Array(W);
  const EXP = Array.from({ length: NOUT }, () => new Uint32Array(W));
  for (let r = 0; r < R; r++) {
    const w = r >>> 5;
    const bit = 1 << (r & 31);
    for (let i = 0; i < nIn; i++) if ((r >>> i) & 1) SIG[2 + i][w] |= bit;
    for (let k = 0; k < NOUT; k++) if ((ys[r] >>> k) & 1) EXP[k][w] |= bit;
  }
  const TAIL = R % 32 === 0 ? 0xffffffff : ((1 << (R % 32)) - 1) >>> 0;

  const gates = net.gates.map((g) => [...g]);
  const outputs = [...net.outputs];

  // Recompute gates from index `from` upward and report whether every row
  // still matches. Gates stay topologically ordered: a move only ever points a
  // gate at a smaller signal.
  function evalFrom(from) {
    for (let i = Math.max(0, from); i < G; i++) {
      const A = SIG[gates[i][0]];
      const B = SIG[gates[i][1]];
      const D = SIG[gate0 + i];
      for (let w = 0; w < W; w++) D[w] = ~(A[w] & B[w]);
    }
    for (let k = 0; k < NOUT; k++) {
      const O = SIG[outputs[k]];
      const E = EXP[k];
      for (let w = 0; w < W; w++) {
        if (((O[w] ^ E[w]) & (w === W - 1 ? TAIL : 0xffffffff)) !== 0) return false;
      }
    }
    return true;
  }

  // Depth the way criticalPathDepth() counts it on the rebuilt circuit: tail
  // outputs (two more stages when buffered) and latch inputs are endpoints.
  function measure() {
    const plan = layout({ nIn, gates, outputs, nOut });
    let score = plan.total;
    let depth = 0;
    let C = null;
    if (objective === "C") {
      const d = new Int32Array(G);
      for (let i = 0; i < G; i++) {
        if (!plan.live[i]) continue;
        let m = 0;
        for (const s of gates[i]) if (s >= gate0) m = Math.max(m, d[s - gate0]);
        d[i] = m + 1;
      }
      const at = (s) => (s >= gate0 ? d[s - gate0] : 0);
      for (let k = 0; k < NOUT; k++) depth = Math.max(depth, at(outputs[k]) + (k < nOut && !plan.deferred[k] ? 2 : 0));
      C = plan.total * Math.max(depth, 1) ** 3;
      score = C;
    }
    return { plan, score, depth, C };
  }

  if (!evalFrom(0)) throw new Error("input netlist is not exact on its table; refusing to minimise");
  let cur = measure().score;
  let best = cur;
  let bestGates = gates.map((g) => [...g]);
  let bestOut = [...outputs];
  let kept = 0, uphill = 0, rejectedInexact = 0, step = 0;

  const legSteps = Math.max(1, Math.ceil(steps / Math.max(1, reheats)));
  for (let heat = 0; heat < reheats && step < steps && G + NOUT > 0; heat++) {
    for (let j = 0; j < legSteps && step < steps; j++, step++) {
      if (onProgress && (step & 4095) === 0) onProgress(step);
      const T = t0 * Math.pow(t1 / t0, j / legSteps);
      let undo;
      if (G > 0 && rng() < 0.85) {
        const i = Math.floor(rng() * G);
        const side = Math.floor(rng() * 2);
        undo = { gate: i, side, was: gates[i][side] };
        gates[i][side] = Math.floor(rng() * (gate0 + i));
      } else {
        const k = Math.floor(rng() * NOUT);
        undo = { output: k, was: outputs[k] };
        outputs[k] = Math.floor(rng() * (gate0 + G));
      }
      const from = undo.gate ?? G;
      const revert = () => {
        if (undo.gate !== undefined) gates[undo.gate][undo.side] = undo.was;
        else outputs[undo.output] = undo.was;
        evalFrom(from);
      };
      if (!evalFrom(from)) {
        rejectedInexact += 1;
        revert();
        continue;
      }
      const s = measure().score;
      const d = s - cur;
      if (d <= 0 || (!greedy && rng() < Math.exp(-d / T))) {
        cur = s;
        kept += 1;
        if (d > 0) uphill += 1;
        if (cur < best) {
          best = cur;
          bestGates = gates.map((g) => [...g]);
          bestOut = [...outputs];
        }
      } else {
        revert();
      }
    }
    for (let i = 0; i < G; i++) gates[i] = [...bestGates[i]];
    for (let k = 0; k < NOUT; k++) outputs[k] = bestOut[k];
    evalFrom(0);
    cur = best;
  }

  if (!evalFrom(0)) throw new Error("internal: annealed netlist failed its own exactness check");
  const final = measure();
  return {
    gates,
    outputs,
    nIn,
    nOut,
    total: final.plan.total,
    liveGates: final.plan.liveCount,
    objective,
    stats: { seed, steps: step, reheats, kept, uphill, rejectedInexact },
  };
}
