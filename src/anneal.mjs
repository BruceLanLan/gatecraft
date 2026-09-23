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
import { layout } from "./rebuild.mjs";
import { createRng } from "./rng.mjs";

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

  // Full recomputation, used once at the start and after each reheat restores the best
  // netlist. Gates stay topologically ordered: a move only ever points a gate at a
  // smaller signal.
  function evalFrom(from) {
    for (let i = Math.max(0, from); i < G; i++) {
      const A = SIG[gates[i][0]];
      const B = SIG[gates[i][1]];
      const D = SIG[gate0 + i];
      for (let w = 0; w < W; w++) D[w] = ~(A[w] & B[w]);
    }
    for (let k = 0; k < NOUT; k++) if (!outputMatches(k)) return false;
    return true;
  }
  function outputMatches(k) {
    const O = SIG[outputs[k]];
    const E = EXP[k];
    for (let w = 0; w < W; w++) {
      if (((O[w] ^ E[w]) & (w === W - 1 ? TAIL : 0xffffffff)) !== 0) return false;
    }
    return true;
  }

  // Which gates read each signal, and which outputs are driven by it, kept current as
  // moves rewire them. This is what lets a step touch only what it can affect.
  const readers = Array.from({ length: gate0 + G }, () => []);
  for (let i = 0; i < G; i++) for (const s of gates[i]) readers[s].push(i);
  const drives = Array.from({ length: gate0 + G }, () => []);
  for (let k = 0; k < NOUT; k++) drives[outputs[k]].push(k);
  const unlink = (list, v) => {
    const at = list.indexOf(v);
    list[at] = list[list.length - 1];
    list.pop();
  };

  // Incremental evaluation of one rewired gate. Only its transitive fan-out can change,
  // and a gate whose recomputed value is unchanged stops the change from travelling
  // further. The previous value of every gate that did change is saved, so undoing the
  // move copies words back instead of evaluating anything again. The result is the same
  // SIG a full recomputation would leave — the search sees exactly what it saw before.
  const dirty = new Uint8Array(G);
  const saved = Array.from({ length: G }, () => new Uint32Array(W));
  const scratch = new Uint32Array(W);
  let changed = [];
  // Gates are visited in index order and a gate reads only smaller signals, so a gate's
  // value is final the moment it is recomputed. An output it drives can therefore be
  // judged right then, and the first wrong one ends the step: the rest of the cone could
  // not make the move exact again. The verdict is the one a full recomputation would give.
  function propagate(start) {
    changed = [];
    dirty[start] = 1;
    let high = start;
    for (let i = start; i <= high; i++) {
      if (!dirty[i]) continue;
      dirty[i] = 0;
      const A = SIG[gates[i][0]];
      const B = SIG[gates[i][1]];
      const D = SIG[gate0 + i];
      let same = true;
      for (let w = 0; w < W; w++) {
        const v = ~(A[w] & B[w]);
        scratch[w] = v;
        if (v !== D[w]) same = false;
      }
      if (same) continue;
      saved[i].set(D);
      D.set(scratch);
      changed.push(i);
      for (const r of readers[gate0 + i]) {
        dirty[r] = 1;
        if (r > high) high = r;
      }
      for (const k of drives[gate0 + i]) {
        if (!outputMatches(k)) {
          for (let j = i + 1; j <= high; j++) dirty[j] = 0; // leave nothing pending for the next step
          return false;
        }
      }
    }
    return true;
  }
  function restore() {
    for (const i of changed) SIG[gate0 + i].set(saved[i]);
    changed = [];
  }

  // A cheap first look on wide tables. Almost every random rewire is wrong on a great many
  // rows, so the cone is first evaluated on the first S words only, without touching SIG.
  // A wrong output there is a wrong output on the whole table, and the step is rejected at
  // a fraction of the cost; only a move that survives the sample is evaluated in full.
  // A gate unchanged on the sampled rows cannot change its readers on those rows, so the
  // sample pass may stop there too. On narrow tables the sample would be the whole table,
  // and this pass is skipped.
  // The sampled words are spread evenly across the table, not taken from its start: the
  // first rows are the ones where every high input bit is 0, and for many functions (a
  // comparator of two halves, for one) the output hardly varies there, so a broken rewire
  // passes the sample and the step pays for a full evaluation anyway. Measured: a 20-bit
  // comparator took 11.6 s with the first-rows sample and far less spread out.
  const S = Math.min(W, 64);
  const PROBE = W > S;
  const SW = PROBE ? Uint32Array.from({ length: S }, (_, k) => Math.floor((k * W) / S)) : null;
  const probe = PROBE ? Array.from({ length: G }, () => new Uint32Array(S)) : null;
  const probeEpoch = PROBE ? new Int32Array(G).fill(-1) : null;
  let epoch = 0;
  // W > 64 means at least 12 table bits, so the row count is a multiple of 32 and no
  // sampled word needs the tail mask.
  function probeRejects(start) {
    epoch += 1;
    dirty[start] = 1;
    let high = start;
    for (let i = start; i <= high; i++) {
      if (!dirty[i]) continue;
      dirty[i] = 0;
      const sa = gates[i][0], sb = gates[i][1];
      const pa = sa >= gate0 && probeEpoch[sa - gate0] === epoch ? probe[sa - gate0] : null;
      const pb = sb >= gate0 && probeEpoch[sb - gate0] === epoch ? probe[sb - gate0] : null;
      const A = SIG[sa], B = SIG[sb], D = SIG[gate0 + i];
      const P = probe[i];
      let same = true;
      for (let k = 0; k < S; k++) {
        const w = SW[k];
        const v = ~((pa ? pa[k] : A[w]) & (pb ? pb[k] : B[w]));
        P[k] = v;
        if (v !== D[w]) same = false;
      }
      if (same) continue;
      probeEpoch[i] = epoch;
      for (const r of readers[gate0 + i]) {
        dirty[r] = 1;
        if (r > high) high = r;
      }
      for (const o of drives[gate0 + i]) {
        const E = EXP[o];
        for (let k = 0; k < S; k++) {
          if ((P[k] ^ E[SW[k]]) !== 0) {
            for (let j = i + 1; j <= high; j++) dirty[j] = 0;
            return true;
          }
        }
      }
    }
    return false;
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
      // The same random draws, in the same order, as the full-recomputation annealer.
      let undo, exact;
      if (G > 0 && rng() < 0.85) {
        const i = Math.floor(rng() * G);
        const side = Math.floor(rng() * 2);
        const was = gates[i][side];
        const to = Math.floor(rng() * (gate0 + i));
        undo = { gate: i, side, was, to };
        gates[i][side] = to;
        unlink(readers[was], i);
        readers[to].push(i);
        if (PROBE && probeRejects(i)) {
          changed = []; // SIG was never written, so there is nothing to restore
          exact = false;
        } else {
          exact = propagate(i);
        }
      } else {
        const k = Math.floor(rng() * NOUT);
        const was = outputs[k];
        const to = Math.floor(rng() * (gate0 + G));
        undo = { output: k, was, to };
        outputs[k] = to;
        unlink(drives[was], k);
        drives[to].push(k);
        changed = [];
        exact = outputMatches(k);
      }
      const revert = () => {
        if (undo.gate !== undefined) {
          gates[undo.gate][undo.side] = undo.was;
          unlink(readers[undo.to], undo.gate);
          readers[undo.was].push(undo.gate);
        } else {
          outputs[undo.output] = undo.was;
          unlink(drives[undo.to], undo.output);
          drives[undo.was].push(undo.output);
        }
        restore();
      };
      if (!exact) {
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
    // The wiring changed wholesale, so the reader and driver lists are rebuilt with it.
    for (const list of readers) list.length = 0;
    for (const list of drives) list.length = 0;
    for (let i = 0; i < G; i++) for (const s of gates[i]) readers[s].push(i);
    for (let k = 0; k < NOUT; k++) drives[outputs[k]].push(k);
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
