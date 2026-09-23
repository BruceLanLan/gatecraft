// Exact NAND synthesis straight from a truth table, with no hand design and no
// training. All outputs share one reduced ordered BDD, so identical
// subfunctions become one node and outputs reuse each other's logic; each
// decision node then becomes a NAND multiplexer.
//
// Exact by construction, which is precisely the kind of claim that ships wrong
// circuits, so the compiler checks every row again after layout.
//
// Input: ys[x] = packed output bits for input row x (x < 2^nIn), nOutputs bits
// per row. Output: { gates, outputs } in the form src/rebuild.mjs lays out.

const TERMINAL_0 = -1;
const TERMINAL_1 = -2;
const key = (lo, hi) => (lo + 2) * 4194304 + (hi + 2);

// A shared ROBDD with reference counts, so adjacent levels can be swapped in
// place: the basis of sifting (Rudell 1993), which moves one variable at a time
// to the level where the diagram is smallest.
export class Bdd {
  constructor(nIn, ys, nOutputs, order) {
    this.nIn = nIn;
    this.varAt = [...order];
    this.levelOf = [];
    order.forEach((v, level) => { this.levelOf[v] = level; });
    this.cap = 1024;
    this.V = new Int32Array(this.cap);
    this.LO = new Int32Array(this.cap);
    this.HI = new Int32Array(this.cap);
    this.REF = new Int32Array(this.cap);
    this.free = [];
    this.top = 0;
    this.count = 0;
    this.work = 0;
    this.unique = Array.from({ length: nIn }, () => new Map());
    this.roots = [];
    for (let k = 0; k < nOutputs; k++) {
      const rec = (depth, row) => {
        if (depth === nIn) return (ys[row] >>> k) & 1 ? TERMINAL_1 : TERMINAL_0;
        const v = order[depth];
        return this.mk(v, rec(depth + 1, row), rec(depth + 1, row | (1 << v)));
      };
      const root = rec(0, 0);
      this.ref(root);
      this.roots.push(root);
    }
  }

  get size() {
    return this.count;
  }

  ref(id) {
    if (id >= 0) this.REF[id] += 1;
  }

  deref(id) {
    if (id >= 0 && --this.REF[id] === 0) {
      this.unique[this.V[id]].delete(key(this.LO[id], this.HI[id]));
      this.count -= 1;
      this.free.push(id);
      this.deref(this.LO[id]);
      this.deref(this.HI[id]);
    }
  }

  // The node (v, lo, hi), shared if it exists. A new node holds references to
  // its children; whoever keeps the returned node must ref() it.
  mk(v, lo, hi) {
    if (lo === hi) return lo;
    const table = this.unique[v];
    const k = key(lo, hi);
    let id = table.get(k);
    if (id !== undefined) return id;
    id = this.free.length ? this.free.pop() : this.top++;
    if (id >= this.cap) {
      this.cap *= 2;
      for (const name of ["V", "LO", "HI", "REF"]) {
        const grown = new Int32Array(this.cap);
        grown.set(this[name]);
        this[name] = grown;
      }
    }
    this.V[id] = v;
    this.LO[id] = lo;
    this.HI[id] = hi;
    this.REF[id] = 0;
    this.ref(lo);
    this.ref(hi);
    table.set(k, id);
    this.count += 1;
    return id;
  }

  // Exchange the variables at levels i and i + 1. Node ids above keep their
  // meaning: a node that depended on both variables is rewritten in place with
  // the lower variable on top and new nodes for the upper one below it.
  swap(i) {
    const a = this.varAt[i];
    const b = this.varAt[i + 1];
    // The node arrays are read through `this` every time, never copied into locals: mk()
    // below can grow them, and a copy taken at the top would keep writing into the old ones.
    // That happened on a 17-bit adder whose diagram crossed the capacity boundary in the
    // middle of a swap - the rewritten nodes landed in arrays nothing read any more, and the
    // diagram that came out had a cycle in it.
    const nodesA = [...this.unique[a].values()];
    this.work += nodesA.length + this.unique[b].size;
    this.unique[a] = new Map();
    const dependent = [];
    for (const f of nodesA) {
      const f0 = this.LO[f];
      const f1 = this.HI[f];
      if ((f0 >= 0 && this.V[f0] === b) || (f1 >= 0 && this.V[f1] === b)) dependent.push(f);
      else this.unique[a].set(key(f0, f1), f);
    }
    for (const f of dependent) {
      const f0 = this.LO[f];
      const f1 = this.HI[f];
      const f0b = f0 >= 0 && this.V[f0] === b;
      const f1b = f1 >= 0 && this.V[f1] === b;
      const lo = this.mk(a, f0b ? this.LO[f0] : f0, f1b ? this.LO[f1] : f1);
      const hi = this.mk(a, f0b ? this.HI[f0] : f0, f1b ? this.HI[f1] : f1);
      this.ref(lo);
      this.ref(hi);
      this.V[f] = b;
      this.LO[f] = lo;
      this.HI[f] = hi;
      this.unique[b].set(key(lo, hi), f);
      this.deref(f0);
      this.deref(f1);
    }
    this.varAt[i] = b;
    this.varAt[i + 1] = a;
    this.levelOf[a] = i + 1;
    this.levelOf[b] = i;
  }

  // Move each variable, largest level first, through every level and leave it
  // where the diagram was smallest. A deterministic budget of node visits
  // bounds the time on wide tables.
  sift({ maxWork = 2e7, maxGrowth = 1.2, passes = 3 } = {}) {
    const { nIn, levelOf } = this;
    for (let pass = 0; pass < passes; pass++) {
      const before = this.count;
      const vars = [...Array(nIn).keys()].sort((p, q) => this.unique[q].size - this.unique[p].size || p - q);
      for (const v of vars) {
        let best = this.count;
        let bestLevel = levelOf[v];
        while (levelOf[v] < nIn - 1 && this.work < maxWork) {
          this.swap(levelOf[v]);
          if (this.count < best) {
            best = this.count;
            bestLevel = levelOf[v];
          } else if (this.count > best * maxGrowth) {
            break;
          }
        }
        while (levelOf[v] > 0 && this.work < maxWork) {
          this.swap(levelOf[v] - 1);
          if (this.count < best) {
            best = this.count;
            bestLevel = levelOf[v];
          } else if (levelOf[v] < bestLevel && this.count > best * maxGrowth) {
            break;
          }
        }
        while (levelOf[v] < bestLevel) this.swap(levelOf[v]);
        while (levelOf[v] > bestLevel) this.swap(levelOf[v] - 1);
      }
      if (this.count >= before || this.work >= maxWork) break;
    }
  }

  // Plain nodes [v, lo, hi] numbered children first, and the roots in output order.
  export() {
    const ids = new Map();
    const nodes = [];
    const visit = (id) => {
      if (id < 0) return id;
      if (ids.has(id)) return ids.get(id);
      const lo = visit(this.LO[id]);
      const hi = visit(this.HI[id]);
      nodes.push([this.V[id], lo, hi]);
      ids.set(id, nodes.length - 1);
      return nodes.length - 1;
    };
    const roots = this.roots.map(visit);
    return { nodes, roots, order: [...this.varAt] };
  }
}

// Every BDD node is a multiplexer: mux(s, lo, hi) = s ? hi : lo. In general that is
// NAND(NAND(s, hi), NAND(NOT s, lo)), but a node with a constant branch is an AND or an OR
// and needs half of that, and a gate fed a constant is not a gate at all. On wide tables
// annealing gets almost no steps, so whatever this emits is what ships: the gates below are
// normalised as they are made rather than left for annealing to find.
//
// Signals: 0 and 1 are the constants, 2..nIn+1 the inputs, then one per gate.
function emit(nIn, { nodes, roots }) {
  const gate0 = 2 + nIn;
  const gates = [];
  const cse = new Map();
  const complement = new Map(); // signal -> a signal known to be its negation

  const raw = (a, b) => {
    const k = a <= b ? `${a},${b}` : `${b},${a}`;
    let id = cse.get(k);
    if (id === undefined) {
      gates.push([a, b]);
      id = gate0 + gates.length - 1;
      cse.set(k, id);
    }
    return id;
  };
  const not = (a) => {
    if (a === 0) return 1;
    if (a === 1) return 0;
    const known = complement.get(a);
    if (known !== undefined) return known;
    const g = raw(a, a);
    complement.set(a, g);
    complement.set(g, a);
    return g;
  };
  const nand = (a, b) => {
    if (a === 0 || b === 0) return 1;
    if (a === 1) return not(b);
    if (b === 1 || a === b) return not(a);
    if (complement.get(a) === b) return 1; // NAND(x, NOT x)
    const g = raw(a, b);
    return g;
  };
  const and = (a, b) => not(nand(a, b));
  const or = (a, b) => nand(not(a), not(b));

  // A diagram without complement edges keeps f and NOT f as two separate sets of nodes, and
  // XOR-heavy functions are full of such pairs: a carry chain and its negation, a parity and
  // its inverse. Measured on the diagrams this synthesizer builds, 61-93% of the nodes of
  // adders, bit counts and parity also exist as their own complement. Once one of the pair is
  // built, the other is a single inverter rather than another multiplexer.
  const key = new Map(nodes.map(([v, lo, hi], id) => [`${v},${lo},${hi}`, id]));
  const complementNode = new Map([[TERMINAL_0, TERMINAL_1], [TERMINAL_1, TERMINAL_0]]);
  const complementOf = (id) => {
    if (complementNode.has(id)) return complementNode.get(id);
    const [v, lo, hi] = nodes[id];
    const cl = complementOf(lo), ch = complementOf(hi);
    const c = cl === undefined || ch === undefined ? undefined : key.get(`${v},${cl},${ch}`);
    complementNode.set(id, c);
    return c;
  };

  const signalOf = new Map();
  const signal = (id) => {
    if (id === TERMINAL_0) return 0;
    if (id === TERMINAL_1) return 1;
    if (signalOf.has(id)) return signalOf.get(id);
    const twin = complementOf(id);
    if (twin !== undefined && signalOf.has(twin)) {
      const out = not(signalOf.get(twin));
      signalOf.set(id, out);
      return out;
    }
    const [v, lo, hi] = nodes[id];
    const s = 2 + v;
    const loSig = signal(lo);
    const hiSig = signal(hi);
    let out;
    if (loSig === hiSig) out = loSig;
    else if (hiSig === 1 && loSig === 0) out = s;
    else if (hiSig === 0 && loSig === 1) out = not(s);
    else if (loSig === 0) out = and(s, hiSig);
    else if (hiSig === 0) out = and(not(s), loSig);
    else if (hiSig === 1) out = or(s, loSig);
    else if (loSig === 1) out = or(not(s), hiSig);
    else out = nand(nand(s, hiSig), nand(not(s), loSig));
    signalOf.set(id, out);
    return out;
  };
  return { gates, outputs: roots.map(signal) };
}

// BDD size depends heavily on variable order and the best order is NP-hard to
// find. Try the natural order, its reverse and a few seeded shuffles (fewer on
// wide tables, where each one visits all 2^nIn rows), then sift the smallest
// diagram. Every candidate is judged by the NAND count it emits, so sifting is
// only kept when it helps.
export function defaultOrders(nIn) {
  return nIn <= 12 ? 32 : nIn <= 16 ? 8 : 2;
}

export function synthesize({ nIn, ys, nOutputs }, { rng, orders = defaultOrders(nIn), sift = true } = {}) {
  if (!(nIn >= 1 && nIn <= 20)) throw new Error("synthesis needs 1..20 input bits");
  if (ys.length !== 2 ** nIn) throw new Error(`table has ${ys.length} rows, expected ${2 ** nIn}`);
  if (typeof rng !== "function") throw new Error("synthesize() needs a seeded rng");

  const candidates = [[...Array(nIn).keys()], [...Array(nIn).keys()].reverse()];
  while (candidates.length < orders) {
    const o = [...Array(nIn).keys()];
    for (let i = o.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [o[i], o[j]] = [o[j], o[i]];
    }
    candidates.push(o);
  }

  let chosen = null;
  const consider = (diagram, sifted) => {
    const net = emit(nIn, diagram);
    if (!chosen || net.gates.length < chosen.net.gates.length) chosen = { diagram, net, sifted };
  };
  let smallest = null;
  for (const order of candidates.slice(0, Math.max(1, orders))) {
    const bdd = new Bdd(nIn, ys, nOutputs, order);
    consider(bdd.export(), false);
    if (!smallest || bdd.size < smallest.size) smallest = bdd;
  }
  if (sift) {
    smallest.sift();
    consider(smallest.export(), true);
  }

  return {
    gates: chosen.net.gates,
    outputs: chosen.net.outputs,
    bddNodes: chosen.diagram.nodes.length,
    ordersTried: Math.max(1, orders),
    sifted: chosen.sifted,
    variableOrder: chosen.diagram.order,
  };
}
