// Structural compilation: a checked expression program straight to NAND gates, keeping the
// arithmetic structure a truth table loses - a ripple-carry adder for "+", a column-compressed
// array multiplier for "*", a borrow chain for "<".
//
// Every node is computed at exactly the width its interval needs (see expr.mjs), in two's
// complement when it can be negative, so nothing overflows and no bit is wasted. Gates are
// folded and shared as they are made: a gate fed a constant is not a gate, NOT NOT x is x,
// and an identical NAND is made once. That folding is what turns a full adder with a
// constant carry into a half adder, and a multiplication by a constant into shifts and adds.
//
// The result is a candidate, not a certificate: compileTable checks it on every row of the
// program's table before using it, and a construct this module does not build (general
// division) throws NotStructural so the table path compiles the program instead.
import { widthOf } from "./expr.mjs";

export class NotStructural extends Error {
  constructor(message) {
    super(message);
    this.name = "NotStructural";
  }
}

// Signals: 0 and 1 are the constants, 2..nIn+1 the input bits, then one per gate.
function gateBuilder(nIn) {
  const gate0 = 2 + nIn;
  const gates = [];
  const cse = new Map();
  const complement = new Map();
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
    if (complement.get(a) === b) return 1;
    return raw(a, b);
  };
  const and = (a, b) => not(nand(a, b));
  const or = (a, b) => nand(not(a), not(b));
  const xor = (a, b) => {
    if (a === 0) return b;
    if (b === 0) return a;
    if (a === 1) return not(b);
    if (b === 1) return not(a);
    if (a === b) return 0;
    if (complement.get(a) === b) return 1;
    const n = nand(a, b);
    return nand(nand(a, n), nand(b, n));
  };
  const mux = (s, lo, hi) => {
    if (s === 0 || lo === hi) return lo;
    if (s === 1) return hi;
    return nand(nand(s, hi), nand(not(s), lo));
  };
  // The classic nine-NAND full adder, sharing NAND(a, b) between sum and carry.
  const full = (a, b, c) => {
    const n1 = nand(a, b);
    const s1 = nand(nand(a, n1), nand(b, n1)); // a xor b
    const n5 = nand(s1, c);
    return { s: nand(nand(s1, n5), nand(c, n5)), c: nand(n5, n1) };
  };
  return { gates, gate0, not, nand, and, or, xor, mux, full };
}

export function buildStructural(program) {
  const { inputs, lets, outputs, nIn } = program;
  const g = gateBuilder(nIn + (program.nState ?? 0));

  // A value is its bits, least significant first, and whether they are two's complement.
  const fit = (v, w) => {
    const fill = v.signed ? v.bits[v.bits.length - 1] : 0;
    const bits = v.bits.slice(0, w);
    while (bits.length < w) bits.push(fill);
    return bits;
  };
  const value = (bits, range) => ({ bits, signed: range[0] < 0n });
  const orAll = (bits) => bits.reduce((acc, b) => g.or(acc, b), 0);
  const add = (x, y, carry, w) => {
    const out = [];
    let c = carry;
    for (let i = 0; i < w; i++) {
      const r = g.full(x[i], y[i], c);
      out.push(r.s);
      c = r.c;
    }
    return out;
  };
  const sub = (x, y, w) => add(x, y.map(g.not), 1, w);

  const multiply = (x, y, w) => {
    const cols = Array.from({ length: w }, () => []);
    for (let i = 0; i < w; i++) for (let j = 0; i + j < w; j++) {
      const p = g.and(x[i], y[j]);
      if (p !== 0) cols[i + j].push(p);
    }
    const out = [];
    for (let k = 0; k < w; k++) {
      const col = cols[k];
      while (col.length > 2) {
        const r = g.full(col.shift(), col.shift(), col.shift());
        col.push(r.s);
        if (k + 1 < w) cols[k + 1].push(r.c);
      }
      if (col.length === 2) {
        const r = g.full(col[0], col[1], 0);
        if (k + 1 < w) cols[k + 1].push(r.c);
        out.push(r.s);
      } else out.push(col.length ? col[0] : 0);
    }
    return out;
  };

  // Shift by a constant or, through a barrel of multiplexers, by a value.
  const shift = (v, amount, left, w) => {
    const src = fit(v, Math.max(w, v.bits.length) + (left ? 0 : 64));
    const fill = !left && v.signed ? v.bits[v.bits.length - 1] : 0;
    const at = (bits, i) => (i >= 0 && i < bits.length ? bits[i] : i < 0 ? 0 : fill);
    if (amount.constant !== undefined) {
      const k = amount.constant;
      return Array.from({ length: w }, (_, i) => at(src, left ? i - k : i + k));
    }
    let cur = src.slice(0, Math.max(w, v.bits.length) + (left ? 0 : 1));
    const width = cur.length;
    let overflow = 0;
    amount.bits.forEach((s, j) => {
      const step = 2 ** j;
      if (step >= width) { overflow = g.or(overflow, s); return; }
      cur = Array.from({ length: width }, (_, i) => g.mux(s, cur[i], at(cur, left ? i - step : i + step)));
    });
    return Array.from({ length: w }, (_, i) => g.mux(overflow, at(cur, i), left ? 0 : fill));
  };

  const lessThan = (a, b) => {
    // a < b exactly when a - b is negative, computed wide enough to be exact
    const diff = [a.node.range[0] - b.node.range[1], a.node.range[1] - b.node.range[0]];
    if (diff[0] >= 0n) return 0;
    if (diff[1] < 0n) return 1;
    const w = widthOf(diff);
    return sub(fit(a.v, w), fit(b.v, w), w)[w - 1];
  };
  const equal = (a, b) => {
    const w = Math.max(a.v.bits.length, b.v.bits.length) + 1;
    const x = fit(a.v, w), y = fit(b.v, w);
    return x.reduce((acc, bit, i) => g.and(acc, g.not(g.xor(bit, y[i]))), 1);
  };

  const env = new Map();
  let offset = 0;
  // State bits follow the input bits: a latch output reads like one more input.
  for (const i of [...inputs, ...(program.states ?? [])]) {
    env.set(i.name, { bits: Array.from({ length: i.width }, (_, k) => 2 + offset + k), signed: false });
    offset += i.width;
  }

  function build(node) {
    const w = widthOf(node.range);
    const arg = (k) => ({ node: node.args[k], v: build(node.args[k]) });
    switch (node.op) {
      case "num": {
        const n = BigInt.asUintN(w, node.value);
        return value(Array.from({ length: w }, (_, i) => Number((n >> BigInt(i)) & 1n)), node.range);
      }
      case "name": return env.get(node.name);
      case "neg": return value(sub(Array(w).fill(0), fit(arg(0).v, w), w), node.range);
      case "~": return value(fit(arg(0).v, w).map(g.not), node.range);
      case "!": return value([g.not(orAll(arg(0).v.bits))], node.range);
      case "+": return value(add(fit(arg(0).v, w), fit(arg(1).v, w), 0, w), node.range);
      case "-": return value(sub(fit(arg(0).v, w), fit(arg(1).v, w), w), node.range);
      case "*": return value(multiply(fit(arg(0).v, w), fit(arg(1).v, w), w), node.range);
      case "/": case "%": {
        const d = node.args[1];
        const c = d.range[0] === d.range[1] ? d.range[0] : null;
        if (c === null || (c & (c - 1n)) !== 0n) throw new NotStructural(`"${node.op}" by a value other than a constant power of two`);
        const k = c.toString(2).length - 1;
        const x = arg(0).v;
        return node.op === "/"
          ? value(shift(x, { constant: k }, false, w), node.range)
          : value(fit(x, w).map((bit, i) => (i < k ? bit : 0)), node.range);
      }
      case "<<": case ">>": case ">>>": {
        const s = node.args[1];
        const x = arg(0).v;
        const amount = s.range[0] === s.range[1] ? { constant: Number(s.range[0]) } : { bits: build(s).bits };
        return value(shift(x, amount, node.op === "<<", w), node.range);
      }
      case "&": case "|": case "^": {
        const x = fit(arg(0).v, w), y = fit(arg(1).v, w);
        const f = node.op === "&" ? g.and : node.op === "|" ? g.or : g.xor;
        return value(x.map((bit, i) => f(bit, y[i])), node.range);
      }
      case "==": return value([equal(arg(0), arg(1))], node.range);
      case "!=": return value([g.not(equal(arg(0), arg(1)))], node.range);
      case "<": return value([lessThan(arg(0), arg(1))], node.range);
      case ">": return value([lessThan(arg(1), arg(0))], node.range);
      case "<=": return value([g.not(lessThan(arg(1), arg(0)))], node.range);
      case ">=": return value([g.not(lessThan(arg(0), arg(1)))], node.range);
      case "&&": return value([g.and(orAll(arg(0).v.bits), orAll(arg(1).v.bits))], node.range);
      case "||": return value([g.or(orAll(arg(0).v.bits), orAll(arg(1).v.bits))], node.range);
      case "?:": {
        const c = orAll(arg(0).v.bits);
        const yes = fit(arg(1).v, w), no = fit(arg(2).v, w);
        return value(yes.map((bit, i) => g.mux(c, no[i], bit)), node.range);
      }
      case "slice": {
        const x = arg(0).v;
        const bits = fit(x, Math.max(x.bits.length, node.hi + 1));
        return value(bits.slice(node.lo, node.hi + 1), node.range);
      }
      default: throw new Error(`internal: cannot build ${node.op}`);
    }
  }

  for (const l of lets) env.set(l.name, build(l.tree));
  const outBits = [];
  for (const o of [...outputs, ...(program.states ?? [])]) outBits.push(...fit(build(o.tree), o.width));
  return { gates: g.gates, outputs: outBits };
}
