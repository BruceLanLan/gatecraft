// A program too wide for one proof, delivered as several small circuits that each get one.
//
// The whole guarantee of this compiler is "checked on every row", and every row means every
// combination of the input and state bits: 20 bits is a million rows and the practical end of
// that. A four-team scoreboard, a lock with a longer code, a game with a few pieces on a board
// all pass 20 bits while every individual rule in them stays tiny - "this team's score goes up
// when its button is pressed" reads five bits, not forty.
//
// So the program is cut at its names. Each state's "next", each output, and each "let" that
// can be handed over as a whole value becomes its own block: a combinational circuit over just
// the names that expression reads. Every block is proven on every one of ITS rows, exactly as
// a whole program is today. What joins them is a top circuit with no logic in it at all: the
// latches that hold the state, and one REF per block - TapeOut's own opcode for "run that
// deployed circuit on these signals". Identical blocks (the same function on the same widths,
// as tables) are deployed once and referred to from every place they are used.
//
// Why cutting at names is sound: a block for the name N computes N's expression exactly, over
// the exact values of what it reads. A "let" is only cut when its value is never negative and
// fits in a whole number of bits, so passing it between blocks loses nothing; a let that can
// go negative is inlined into whatever reads it and never crosses a wire. Outputs and next
// states are cut to their width by the block precisely where the flat compiler cuts them.
// A wire carries every value of its width, including ones the let can never take; a block
// is proven on all of them, and on the unreachable ones (where an expression may even divide
// by zero) it is allowed to give anything, because nothing ever feeds them in. Composition
// therefore evaluates the same program on every reachable row, and the end-to-end check
// below is a cross-check of the wiring, not the source of the guarantee.
//
// The same blocks are also delivered unlinked: a manifest naming which block reads which
// signals and which writes which state, for a caller that keeps the state itself and replays
// the blocks in order. Whether to link with REF or replay is the person's choice; nothing here
// prefers one.
import { compileTable, tableDigest } from "./compile.mjs";
import { ExprError, MAX_INPUT_BITS, parseProgram, runProgram, runStep, widthOf } from "./expr.mjs";
import { OPCODE, bytesToHex, circuitFromElements, criticalPathDepth, encodeElements, simulate } from "./netlist.mjs";
import { buildStructural, NotStructural } from "./structural.mjs";

// Where the blocks live is not known until they are deployed; until then the REFs point at
// the zero address and block indexes, and linkTop() fills in the real ones.
export const UNLINKED_CPU = `0x${"0".repeat(40)}`;
// A block's outputs are packed into a Uint32 table row, like any table this compiler proves.
const MAX_BLOCK_OUT = 32;

// ---------------------------------------------------------------- cutting the program


// Substitutes inlined lets into a tree, recursively, and returns the copy.
function expand(node, inlined) {
  if (node.op === "name" && inlined.has(node.name)) return expand(inlined.get(node.name), inlined);
  const out = { ...node };
  if (node.args) out.args = node.args.map((a) => expand(a, inlined));
  return out;
}

function namesIn(node, into = new Set()) {
  if (node.op === "name") into.add(node.name);
  for (const a of node.args ?? []) namesIn(a, into);
  return into;
}

// The plan: which names become wires, and one block per computed name.
export function partition(program) {
  const signals = new Map(); // name -> width, in declaration order: inputs, states, cut lets
  for (const f of [...program.inputs, ...(program.states ?? [])]) signals.set(f.name, f.width);

  const inlined = new Map();
  const nodes = [];
  const block = (name, kind, width, tree) => {
    const expanded = expand(tree, inlined);
    const reads = [...signals.keys()].filter((n) => namesIn(expanded).has(n));
    const bits = reads.reduce((s, n) => s + signals.get(n), 0);
    if (bits > MAX_INPUT_BITS) {
      throw new ExprError(
        `"${name}" reads ${bits} bits (${reads.join(", ")}); each part is checked on every row, so a part can read at most ${MAX_INPUT_BITS}. Name a piece of it with "let" so that no single name reads more than that`,
      );
    }
    if (width > MAX_BLOCK_OUT) throw new ExprError(`"${name}" is ${width} bits wide; a part can be at most ${MAX_BLOCK_OUT}`);
    nodes.push({ name, kind, width, reads, tree: expanded });
  };

  for (const l of program.lets) {
    const range = l.tree.range;
    // A let is a wire only when its whole value fits on one: never negative, and narrow enough.
    if (range[0] >= 0n && widthOf(range) <= MAX_BLOCK_OUT) {
      block(l.name, "let", widthOf(range), l.tree);
      signals.set(l.name, widthOf(range));
    } else {
      inlined.set(l.name, l.tree);
    }
  }
  for (const st of program.states ?? []) block(st.name, "state", st.width, st.tree);
  for (const o of program.outputs) block(o.name, "output", o.width, o.tree);
  return { signals, nodes, inlined: [...inlined.keys()] };
}

// A block as a program of its own, so the ordinary table builder and structural front end
// read it. A constant block still needs a row index, so it reads the first signal and
// ignores it.
function blockProgram(node, signals, fallback) {
  const reads = node.reads.length ? node.reads : [fallback];
  const inputs = reads.map((name) => ({ name, width: signals.get(name) }));
  const nIn = inputs.reduce((s, i) => s + i.width, 0);
  return { inputs, states: [], lets: [], outputs: [{ name: node.name, width: node.width, tree: node.tree }], nIn, nState: 0, nOut: node.width, examples: [] };
}

// The block's table, row by row. A row whose inputs a cut let can never produce is
// unreachable; if the expression cannot even be evaluated there (a divisor that is 0 only
// outside the let's range), the row is filled with 0 and counted, and nothing depends on it.
function blockTable(bp) {
  const ys = new Uint32Array(2 ** bp.nIn);
  let unreachable = 0;
  for (let row = 0; row < ys.length; row++) {
    const given = {};
    let shift = 0;
    for (const i of bp.inputs) { given[i.name] = (row >>> shift) & (2 ** i.width - 1); shift += i.width; }
    try {
      ys[row] = Number(runProgram(bp, given, { raw: true })[bp.outputs[0].name] & (2n ** BigInt(bp.nOut) - 1n));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      ys[row] = 0;
      unreachable += 1;
    }
  }
  return { nIn: bp.nIn, nState: 0, nOut: bp.nOut, ys, unreachable };
}

function structuralCandidates(program) {
  try {
    const { gates, outputs } = buildStructural(program);
    return [{ frontEnd: "expression", gates, outputs }];
  } catch (error) {
    if (error instanceof NotStructural) return [];
    throw error;
  }
}

// ---------------------------------------------------------------- the top circuit

function topCircuit(program, plan, blockOf, cpu) {
  const { nIn, nOut, nState } = program;
  const elements = [];
  const wires = new Map(); // name -> its signal numbers, least significant first
  let next = 2;
  for (const i of program.inputs) {
    wires.set(i.name, Array.from({ length: i.width }, () => next++));
  }
  const latches = new Map();
  for (const st of program.states ?? []) {
    const q = [];
    for (let b = 0; b < st.width; b++) {
      elements.push({ op: OPCODE.LATCH, d: -1, out: next });
      q.push(next++);
    }
    wires.set(st.name, q);
    latches.set(st.name, elements.slice(-st.width));
  }
  const refs = [];
  for (const node of plan.nodes) {
    const reads = node.reads.length ? node.reads : [program.inputs[0]?.name ?? program.states[0].name];
    const inputs = reads.flatMap((n) => wires.get(n));
    const outputs = Array.from({ length: node.width }, () => next++);
    const b = blockOf.get(node.name);
    elements.push({ op: OPCODE.REF, cpu, circuitId: BigInt(b), inputs, nOut: node.width, outputs });
    refs.push({ name: node.name, kind: node.kind, block: b, reads, inputs, outputs });
    if (node.kind === "let") wires.set(node.name, outputs);
    if (node.kind === "state") latches.get(node.name).forEach((latch, k) => { latch.d = outputs[k]; });
  }
  const circuit = circuitFromElements(elements, nIn, nOut);
  const netlist = encodeElements(elements);
  return {
    circuit: { ...circuit, signalCount: next, nState, depth: criticalPathDepth(circuit), netlist, netlistHex: bytesToHex(netlist), netlistBytes: netlist.length },
    refs,
  };
}

// Fills in where the blocks actually live once they are deployed: the processor address and
// each block's circuit id, in block order. Nothing else about the circuit changes.
export function linkTop(top, { cpu, circuitIds }) {
  const elements = top.elements.map((e) => (e.op === OPCODE.REF ? { ...e, cpu, circuitId: BigInt(circuitIds[Number(e.circuitId)]) } : { ...e }));
  const circuit = circuitFromElements(elements, top.nIn, top.nOut);
  const netlist = encodeElements(elements);
  return { ...top, ...circuit, netlist, netlistHex: bytesToHex(netlist), netlistBytes: netlist.length };
}

// ---------------------------------------------------------------- checking the whole

const pack = (fields, values) => {
  const bits = [];
  for (const f of fields) for (let b = 0; b < f.width; b++) bits.push((Number(values[f.name] ?? 0) >>> b) & 1);
  return bits;
};

// Runs the linked circuit through the ordinary simulator with the blocks as REF targets.
export function stepLinked(top, blocks, inputBits, stateBits) {
  return simulate(top, inputBits, Uint8Array.from(stateBits), (_, id) => blocks[Number(id)].circuit);
}

// The unlinked delivery: the caller holds the state and runs the blocks in manifest order.
// This is the reference for what "replay in order" means, and it is checked against the
// linked circuit below, so a caller following the manifest gets the linked behaviour.
export function stepReplay(program, refs, blocks, inputBits, stateBits) {
  const value = new Map();
  let at = 0;
  for (const i of program.inputs) { value.set(i.name, inputBits.slice(at, at + i.width)); at += i.width; }
  at = 0;
  for (const st of program.states ?? []) { value.set(st.name, stateBits.slice(at, at + st.width)); at += st.width; }
  const nextState = new Map();
  const out = new Map();
  for (const r of refs) {
    const bits = r.reads.flatMap((n) => value.get(n));
    const got = [...simulate(blocks[r.block].circuit, bits).outputs];
    if (r.kind === "let") value.set(r.name, got);
    else if (r.kind === "state") nextState.set(r.name, got);
    else out.set(r.name, got);
  }
  return {
    outputs: program.outputs.flatMap((o) => out.get(o.name)),
    newState: (program.states ?? []).flatMap((st) => nextState.get(st.name)),
  };
}

function xorshift(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function crossCheck(program, top, refs, blocks, seed) {
  const fields = [...program.inputs, ...(program.states ?? [])];
  const bits = program.nIn + program.nState;
  const rows = [];
  for (const e of program.examples) rows.push({ given: e.given, from: "example" });
  const exhaustive = bits <= 16;
  const rng = xorshift(seed);
  const total = exhaustive ? 2 ** bits : 4096;
  for (let k = 0; k < total; k++) {
    const given = {};
    let row = exhaustive ? k : null;
    for (const f of fields) {
      if (exhaustive) { given[f.name] = row & (2 ** f.width - 1); row = Math.floor(row / 2 ** f.width); }
      else given[f.name] = Math.floor(rng() * 2 ** f.width);
    }
    rows.push({ given, from: exhaustive ? "every row" : "sampled" });
  }
  let checked = 0;
  for (const { given } of rows) {
    const want = runStep(program, given);
    const wantOut = pack(program.outputs, want.outputs);
    const wantNext = pack(program.states ?? [], want.next);
    const inputBits = pack(program.inputs, given);
    const stateBits = pack(program.states ?? [], given);
    const linked = stepLinked(top, blocks, inputBits, stateBits);
    const replay = stepReplay(program, refs, blocks, inputBits, stateBits);
    const same = (a, b) => a.length === b.length && a.every((v, i) => (v ? 1 : 0) === (b[i] ? 1 : 0));
    if (!same([...linked.outputs], wantOut) || !same([...linked.newState], wantNext)) {
      throw new Error(`internal: the linked circuit disagrees with the program at ${JSON.stringify(given)}; nothing emitted`);
    }
    if (!same(replay.outputs, wantOut) || !same(replay.newState, wantNext)) {
      throw new Error(`internal: replaying the blocks disagrees with the program at ${JSON.stringify(given)}; nothing emitted`);
    }
    checked += 1;
  }
  return { rows: checked, examples: program.examples.length, exhaustive };
}

// ---------------------------------------------------------------- entry

const place = (items) => {
  let bit = 0;
  return items.map(({ name, width }) => {
    const at = width === 1 ? `bit ${bit}` : `bits ${bit}-${bit + width - 1}`;
    bit += width;
    return { name, width, at };
  });
};

export function composeSpec(spec, { steps, seed, objective, onProgress, cpu = UNLINKED_CPU } = {}) {
  const program = parseProgram(spec, { wide: true });
  const plan = partition(program);
  const report = onProgress ?? (() => {});

  // Compile each distinct block once. Two names with the same table share one circuit.
  const blocks = [];
  const byDigest = new Map();
  const blockOf = new Map();
  const fallback = program.inputs[0]?.name ?? program.states[0].name;
  plan.nodes.forEach((node, k) => {
    const bp = blockProgram(node, plan.signals, fallback);
    const table = blockTable(bp);
    const digest = tableDigest(table);
    if (!byDigest.has(digest)) {
      report({ phase: "block", step: k, steps: plan.nodes.length, name: node.name });
      const result = compileTable(table, { steps, seed, objective, candidates: structuralCandidates(bp) });
      byDigest.set(digest, blocks.length);
      blocks.push({ index: blocks.length, program: bp, table, digest, ...result, names: [] });
    }
    const b = byDigest.get(digest);
    blocks[b].names.push(node.name);
    blockOf.set(node.name, b);
  });

  report({ phase: "verification", step: 0, steps: 0 });
  const { circuit: top, refs } = topCircuit(program, plan, blockOf, cpu);
  if (top.nNand !== 0) throw new Error("internal: the top circuit must contain no logic");
  const endToEnd = crossCheck(program, top, refs, blocks, seed ?? 1);

  const certificate = {
    compiler: blocks[0].certificate.compiler,
    composed: true,
    program: { inputs: place(program.inputs), ...(program.nState ? { state: place(program.states) } : {}), outputs: place(program.outputs), bits: program.nIn + program.nState },
    blocks: blocks.map((b) => ({
      index: b.index,
      computes: refs.filter((r) => r.block === b.index).map((r) => ({ name: r.name, reads: r.reads })),
      nIn: b.table.nIn,
      nOut: b.table.nOut,
      nand: b.certificate.circuit.nand,
      rowsChecked: b.certificate.verification.rowsChecked,
      wrong: b.certificate.verification.wrong,
      ...(b.table.unreachable ? { unreachableRowsFilled: b.table.unreachable } : {}),
      tableSha256: b.certificate.table.sha256,
      netlistSha256: b.certificate.circuit.netlistSha256,
      reproduce: b.certificate.reproduce,
    })),
    top: { nand: 0, latch: top.nLatch, refs: refs.length, netlistBytes: top.netlistBytes, linked: cpu !== UNLINKED_CPU },
    verification: {
      blocks: "each block is checked on every row of its own table",
      wiring: "the top circuit has no NAND: latches, and one REF per block, checked structurally",
      endToEnd: { ...endToEnd, wrong: 0, note: "the linked circuit and the replay manifest both match the program on these rows; this cross-checks the wiring, the per-block proofs are the guarantee" },
      nandTotal: blocks.reduce((s, b) => s + b.certificate.circuit.nand, 0),
    },
    inlined: plan.inlined,
  };
  return { program, plan, blocks, top, refs, certificate };
}

// The replay manifest for a caller that keeps the state itself and does not use REF.
export function replayManifest({ program, refs, blocks }) {
  return {
    format: "gatecraft.replay/1",
    inputs: program.inputs.map((i) => ({ name: i.name, width: i.width })),
    state: (program.states ?? []).map((s) => ({ name: s.name, width: s.width, startsAt: 0 })),
    outputs: program.outputs.map((o) => ({ name: o.name, width: o.width })),
    blocks: blocks.map((b) => ({ index: b.index, nIn: b.table.nIn, nOut: b.table.nOut, netlistHex: b.circuit.netlistHex, netlistSha256: b.certificate.circuit.netlistSha256 })),
    steps: refs.map((r) => ({ run: r.block, reads: r.reads, writes: r.name, as: r.kind })),
    order: "run the steps in order each tick; a let is readable by later steps; every state is replaced together after the last step",
  };
}
