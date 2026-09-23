// Lay out a synthesised NAND netlist as a TapeOut circuit.
//
// Input form (what synthesis and the annealer work on): signal 0 is constant 0,
// signal 1 is constant 1, then nIn inputs, then nLatch latch outputs (q), then
// one signal per gate; a gate reads only smaller signals. `outputs` lists the
// circuit outputs first and the latch next-state signals (d) after them.
//
// TapeOut takes the last nOut signals, in order, as the circuit outputs. An
// output gate can simply be emitted last when no live gate reads it and no
// other output repeats it; every other output (a constant, an input, a latch q,
// a gate something reads, a repeated signal) is copied to the tail through two
// NANDs. Latch d signals need no placement: a LATCH may read any signal,
// including one declared after it.
//
// layout() is the single yardstick for circuit size. The annealer minimises
// layout().total and rebuild() emits exactly that many NANDs.
import { OPCODE, encodeElements, bytesToHex, circuitFromElements, criticalPathDepth, podCost } from "./netlist.mjs";

export function layout({ nIn, nLatch = 0, gates, outputs, nOut = outputs.length - nLatch }) {
  const gate0 = 2 + nIn + nLatch;
  const live = new Uint8Array(gates.length);
  const stack = [...outputs];
  while (stack.length) {
    const s = stack.pop();
    if (s < gate0 || live[s - gate0]) continue;
    live[s - gate0] = 1;
    stack.push(gates[s - gate0][0], gates[s - gate0][1]);
  }
  const readBy = new Set();
  let liveCount = 0;
  for (let i = 0; i < gates.length; i++) {
    if (!live[i]) continue;
    liveCount += 1;
    readBy.add(gates[i][0]);
    readBy.add(gates[i][1]);
  }
  const uses = new Map();
  for (let k = 0; k < nOut; k++) uses.set(outputs[k], (uses.get(outputs[k]) ?? 0) + 1);
  const deferred = outputs.slice(0, nOut).map((s) => s >= gate0 && !readBy.has(s) && uses.get(s) === 1);
  const buffered = deferred.reduce((n, d) => n + (d ? 0 : 1), 0);
  return { gate0, nOut, live, liveCount, deferred, buffered, total: liveCount + 2 * buffered };
}

export function rebuild({ nIn, nLatch = 0, gates, outputs, nOut = outputs.length - nLatch }) {
  if (nOut < 1) throw new Error("a TapeOut circuit needs at least one output");
  if (outputs.length !== nOut + nLatch) throw new Error(`expected ${nOut + nLatch} outputs, got ${outputs.length}`);
  const plan = layout({ nIn, nLatch, gates, outputs, nOut });
  const { gate0, live, deferred } = plan;

  const elements = [];
  const map = new Map();
  for (let s = 0; s < gate0; s++) map.set(s, s);      // constants, inputs and latch q keep their numbers
  for (let i = 0; i < nLatch; i++) elements.push({ op: OPCODE.LATCH, d: -1, out: 2 + nIn + i });
  const signal = (s) => {
    const v = map.get(s);
    if (v === undefined) throw new Error(`internal: signal ${s} used before it was emitted`);
    return v;
  };
  const nand = (a, b) => {
    const out = 2 + nIn + elements.length;
    elements.push({ op: OPCODE.NAND, a, b, out });
    return out;
  };

  const deferredSignals = new Set(outputs.slice(0, nOut).filter((_, k) => deferred[k]));
  for (let i = 0; i < gates.length; i++) {
    const s = gate0 + i;
    if (live[i] && !deferredSignals.has(s)) map.set(s, nand(signal(gates[i][0]), signal(gates[i][1])));
  }
  const firstInverter = new Map();
  for (let k = 0; k < nOut; k++) {
    if (!deferred[k]) {
      const v = signal(outputs[k]);
      firstInverter.set(k, nand(v, v));
    }
  }
  const tail = [];
  for (let k = 0; k < nOut; k++) {
    if (deferred[k]) {
      const s = outputs[k];
      const [a, b] = gates[s - gate0];
      const out = nand(signal(a), signal(b));
      map.set(s, out);
      tail.push(out);
    } else {
      const t = firstInverter.get(k);
      tail.push(nand(t, t));
    }
  }
  for (let i = 0; i < nLatch; i++) elements[i].d = signal(outputs[nOut + i]);

  const signalCount = 2 + nIn + elements.length;
  tail.forEach((s, k) => {
    if (s !== signalCount - nOut + k) throw new Error(`internal: output ${k} is not in its tail slot`);
  });
  const nand_ = elements.length - nLatch;
  if (nand_ !== plan.total) throw new Error(`internal: emitted ${nand_} NAND, layout counted ${plan.total}`);

  const circuit = circuitFromElements(elements, nIn, nOut);
  const netlist = encodeElements(elements);
  return {
    ...circuit,
    signalCount,
    nState: nLatch,
    depth: criticalPathDepth(circuit),
    podCost: podCost(circuit).cost,
    netlist,
    netlistHex: bytesToHex(netlist),
    netlistBytes: netlist.length,
    layout: { liveGates: plan.liveCount, bufferedOutputs: plan.buffered },
  };
}
