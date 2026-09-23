// The expression language: behaviour written as arithmetic on named, sized inputs.
//
//   { "inputs":  { "a": 8, "b": 8 },
//     "let":     { "t": "a + b" },                       (optional, in order)
//     "outputs": { "sum": { "width": 9, "expr": "t" } } }
//
// Behaviour with memory adds state: each state value is held in latches, starts at 0 when
// the circuit powers on, and on every clock tick becomes its "next" expression. State names
// read the current value anywhere an input can be read.
//
//     "state":   { "count": { "width": 4, "next": "press ? (count == 9 ? 0 : count + 1) : count" } }
//
// It exists because a table throws structure away. "a + b" over two 8-bit inputs is a
// 65,536-row table to the BDD synthesizer, which cannot see that it is an adder; written as
// an expression it compiles to a ripple-carry adder directly. It is also the form a person or
// a language model can write reliably for arithmetic, where a table is not.
//
// Semantics are this module's own and never borrowed from JavaScript: values are exact
// mathematical integers (BigInt), negative intermediates are allowed, and each output is its
// value modulo 2^width - the two's-complement truncation hardware performs. Operators and
// precedence follow JavaScript/C so the syntax is familiar:
//
//   ?:   ||   &&   |   ^   &   == != === !==   < <= > >=   << >> >>>   + -   * / %
//   unary ~ ! -     postfix a[i] and a[hi:lo] (constant bit indices)     literals 12 0xff 0b1010
//
// Every node carries an interval [lo, hi] of the values it can take. That interval fixes the
// exact number of bits the structural compiler gives the node, so no intermediate overflows.
// The evaluator below builds the table the compiled circuit is verified against, on every row.
// Inputs are packed into the row index least significant bit first, in declaration order;
// outputs likewise into the row value.

export class ExprError extends Error {
  constructor(message, where) {
    super(where ? `${where}: ${message}` : message);
    this.name = "ExprError";
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["true", "false", "x_unused"]);
export const MAX_INPUT_BITS = 20;
export const MAX_OUTPUT_BITS = 32;

// ---------------------------------------------------------------- lexer

const PUNCT = ["===", "!==", ">>>", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "?", ":", "(", ")", "[", "]", "~", "!", "-", "+", "*", "/", "%", "<", ">", "&", "^", "|"];

function lex(source, where) {
  if (typeof source !== "string") throw new ExprError("an expression must be a string", where);
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)/.exec(source.slice(i));
      const text = m[0].replace(/_/g, "");
      if (/^0[0-9]/.test(text)) throw new ExprError(`number "${m[0]}" at position ${i} has a leading zero; write it without one`, where);
      tokens.push({ kind: "num", value: BigInt(text), at: i });
      i += m[0].length;
      if (/[A-Za-z0-9_]/.test(source[i] ?? "")) throw new ExprError(`unexpected "${source[i]}" right after a number at position ${i}`, where);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ kind: "id", value: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const p = PUNCT.find((op) => source.startsWith(op, i));
    if (!p) throw new ExprError(`unexpected "${c}" at position ${i}`, where);
    tokens.push({ kind: "op", value: p === "===" ? "==" : p === "!==" ? "!=" : p, at: i });
    i += p.length;
  }
  tokens.push({ kind: "end", at: source.length });
  return tokens;
}

// ---------------------------------------------------------------- parser (precedence climbing)

const BINARY = [
  ["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", "<=", ">", ">="], ["<<", ">>", ">>>"], ["+", "-"], ["*", "/", "%"],
];

export function parseExpression(source, where) {
  const tokens = lex(source, where);
  let k = 0;
  const peek = () => tokens[k];
  const fail = (msg) => { throw new ExprError(`${msg} at position ${peek().at}`, where); };
  const expect = (op) => {
    if (peek().kind !== "op" || peek().value !== op) fail(`expected "${op}"`);
    return tokens[k++];
  };

  function ternary() {
    const cond = binary(0);
    if (peek().kind === "op" && peek().value === "?") {
      const at = tokens[k++].at;
      const yes = ternary();
      expect(":");
      const no = ternary();
      return { op: "?:", args: [cond, yes, no], at };
    }
    return cond;
  }
  function binary(level) {
    if (level === BINARY.length) return unary();
    let left = binary(level + 1);
    while (peek().kind === "op" && BINARY[level].includes(peek().value)) {
      const { value, at } = tokens[k++];
      left = { op: value, args: [left, binary(level + 1)], at };
    }
    return left;
  }
  function unary() {
    if (peek().kind === "op" && ["~", "!", "-"].includes(peek().value)) {
      const { value, at } = tokens[k++];
      return { op: value === "-" ? "neg" : value, args: [unary()], at };
    }
    return postfix();
  }
  function postfix() {
    let node = primary();
    while (peek().kind === "op" && peek().value === "[") {
      const at = tokens[k++].at;
      const hi = constantIndex();
      let lo = hi;
      if (peek().kind === "op" && peek().value === ":") { k++; lo = constantIndex(); }
      expect("]");
      if (lo > hi) throw new ExprError(`bit slice [${hi}:${lo}] at position ${at} has its high index below its low index`, where);
      node = { op: "slice", args: [node], hi, lo, at };
    }
    return node;
  }
  function constantIndex() {
    const t = peek();
    if (t.kind !== "num") fail("a bit index must be a constant number");
    k++;
    if (t.value > 1024n) throw new ExprError(`bit index ${t.value} at position ${t.at} is too large`, where);
    return Number(t.value);
  }
  function primary() {
    const t = peek();
    if (t.kind === "num") { k++; return { op: "num", value: t.value, at: t.at }; }
    if (t.kind === "id") { k++; return { op: "name", name: t.value, at: t.at }; }
    if (t.kind === "op" && t.value === "(") { k++; const e = ternary(); expect(")"); return e; }
    if (t.kind === "end") fail("the expression ends too early");
    fail(`unexpected "${t.value}"`);
  }

  const tree = ternary();
  if (peek().kind !== "end") fail(`unexpected "${peek().value}"`);
  return tree;
}

// ---------------------------------------------------------------- intervals and widths

const bitlen = (n) => (n <= 0n ? 0 : n.toString(2).length);
export function widthOf([lo, hi]) {
  if (lo >= 0n) return Math.max(1, bitlen(hi));
  return Math.max(bitlen(hi) + 1, bitlen(-lo - 1n) + 1);
}
const pow2 = (n) => 1n << BigInt(n);
const minOf = (...v) => v.reduce((a, b) => (b < a ? b : a));
const maxOf = (...v) => v.reduce((a, b) => (b > a ? b : a));
const MAX_WIDTH = 256;

// Annotates every node with .range = [lo, hi] and returns the root range. `env` maps a name
// to its range. Constructs whose result is not bounded tightly enough to compile are refused
// here, with the reason, rather than later in the circuit.
function analyze(node, env, where) {
  const here = (msg) => new ExprError(`${msg} (at position ${node.at})`, where);
  const r = (range) => {
    if (widthOf(range) > MAX_WIDTH) throw here(`this value needs more than ${MAX_WIDTH} bits`);
    node.range = range;
    return range;
  };
  const a = () => analyze(node.args[0], env, where);
  const b = () => analyze(node.args[1], env, where);
  switch (node.op) {
    case "num": return r([node.value, node.value]);
    case "name": {
      if (!env.has(node.name)) throw here(`unknown name "${node.name}"; inputs and earlier "let" names can be used`);
      return r(env.get(node.name));
    }
    case "neg": { const [lo, hi] = a(); return r([-hi, -lo]); }
    case "~": { const [lo, hi] = a(); return r([-hi - 1n, -lo - 1n]); }
    case "!": a(); return r([0n, 1n]);
    case "+": { const [al, ah] = a(), [bl, bh] = b(); return r([al + bl, ah + bh]); }
    case "-": { const [al, ah] = a(), [bl, bh] = b(); return r([al - bh, ah - bl]); }
    case "*": {
      const [al, ah] = a(), [bl, bh] = b();
      const c = [al * bl, al * bh, ah * bl, ah * bh];
      return r([minOf(...c), maxOf(...c)]);
    }
    case "/": case "%": {
      const [al, ah] = a(), [bl, bh] = b();
      if (al < 0n) throw here(`"${node.op}" needs a dividend that cannot be negative`);
      if (bl <= 0n) throw here(`"${node.op}" needs a divisor that is always at least 1`);
      return r(node.op === "/" ? [al / bh, ah / bl] : [0n, minOf(ah, bh - 1n)]);
    }
    case "<<": case ">>": case ">>>": {
      const [al, ah] = a(), [sl, sh] = b();
      if (sl < 0n) throw here(`a shift amount must not be negative`);
      if (sh > 64n) throw here(`a shift amount above 64 is not supported`);
      if (node.op === ">>>" && al < 0n) throw here(`">>>" needs a value that cannot be negative; use ">>" for signed values`);
      if (node.op === "<<") return r([minOf(al * pow2(sl), al * pow2(sh)), maxOf(ah * pow2(sl), ah * pow2(sh))]);
      // floor division by 2^k is monotonic in the value and, for the sign of each bound, in k
      const c = [al >> sl, al >> sh, ah >> sl, ah >> sh];
      return r([minOf(...c), maxOf(...c)]);
    }
    case "&": case "|": case "^": {
      const ra = a(), rb = b();
      if (ra[0] >= 0n && rb[0] >= 0n) {
        const top = pow2(Math.max(widthOf(ra), widthOf(rb))) - 1n;
        return r(node.op === "&" ? [0n, minOf(ra[1], rb[1])] : [0n, top]);
      }
      // In two's complement a non-negative value needs one more bit than its unsigned width
      // (for its 0 sign bit), so -1 ^ 1 = -2 needs two bits, not one.
      const signedWidth = (range) => widthOf(range) + (range[0] >= 0n ? 1 : 0);
      const w = Math.max(signedWidth(ra), signedWidth(rb));
      return r([-pow2(w - 1), pow2(w - 1) - 1n]);
    }
    case "==": case "!=": case "<": case "<=": case ">": case ">=": case "&&": case "||": a(); b(); return r([0n, 1n]);
    case "?:": {
      analyze(node.args[0], env, where);
      const [yl, yh] = analyze(node.args[1], env, where), [nl, nh] = analyze(node.args[2], env, where);
      return r([minOf(yl, nl), maxOf(yh, nh)]);
    }
    case "slice": { a(); return r([0n, pow2(node.hi - node.lo + 1) - 1n]); }
    default: throw here(`internal: unknown operator ${node.op}`);
  }
}

// ---------------------------------------------------------------- reference evaluation

const truth = (v) => (v !== 0n ? 1n : 0n);
function evaluate(node, env) {
  switch (node.op) {
    case "num": return node.value;
    case "name": return env.get(node.name);
    case "neg": return -evaluate(node.args[0], env);
    case "~": return ~evaluate(node.args[0], env);
    case "!": return evaluate(node.args[0], env) === 0n ? 1n : 0n;
    case "?:": return evaluate(node.args[0], env) !== 0n ? evaluate(node.args[1], env) : evaluate(node.args[2], env);
    case "slice": return (evaluate(node.args[0], env) >> BigInt(node.lo)) & (pow2(node.hi - node.lo + 1) - 1n);
    case "&&": return truth(evaluate(node.args[0], env)) & truth(evaluate(node.args[1], env));
    case "||": return truth(evaluate(node.args[0], env)) | truth(evaluate(node.args[1], env));
  }
  const x = evaluate(node.args[0], env), y = evaluate(node.args[1], env);
  switch (node.op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return x / y; // both non-negative here, so truncation is floor
    case "%": return x % y;
    case "<<": return x << y;
    case ">>": case ">>>": return x >> y; // BigInt >> is floor division by 2^y, for either sign
    case "&": return x & y;
    case "|": return x | y;
    case "^": return x ^ y;
    case "==": return x === y ? 1n : 0n;
    case "!=": return x !== y ? 1n : 0n;
    case "<": return x < y ? 1n : 0n;
    case "<=": return x <= y ? 1n : 0n;
    case ">": return x > y ? 1n : 0n;
    case ">=": return x >= y ? 1n : 0n;
  }
  throw new Error(`internal: cannot evaluate ${node.op}`);
}

// ---------------------------------------------------------------- programs

const entries = (value, what) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.entries(value);
  throw new ExprError(`${what} must be an object (or a list of [name, ...] pairs)`);
};

// A checked program: named inputs with widths, ordered let definitions, named outputs with
// widths and expressions, every expression parsed and annotated with ranges.
// `wide` lifts the per-program bit ceilings: a wide program is not checked as one table but
// split into blocks that each fit (compose.mjs), so only each block's width is bounded.
export function parseProgram(spec, { wide = false } = {}) {
  const maxInputBits = wide ? 4096 : MAX_INPUT_BITS;
  const maxOutputBits = wide ? 4096 : MAX_OUTPUT_BITS;
  if (!spec || typeof spec !== "object") throw new ExprError("the spec must be an object with inputs and outputs");
  const inputs = entries(spec.inputs, "inputs").map(([name, width]) => {
    if (typeof name !== "string" || !IDENT.test(name) || RESERVED.has(name)) throw new ExprError(`input name ${JSON.stringify(name)} must be a plain identifier`);
    if (!Number.isInteger(width) || width < 1) throw new ExprError(`input "${name}" needs a whole-number width of at least 1`);
    return { name, width };
  });
  const nIn = inputs.reduce((s, i) => s + i.width, 0);
  const stateDefs = entries(spec.state ?? {}, "state").map(([name, def]) => {
    if (!def || typeof def !== "object" || typeof def.next !== "string") throw new ExprError(`state "${name}" needs a "next" expression: its value after each clock tick`);
    if (!Number.isInteger(def.width) || def.width < 1) throw new ExprError(`state "${name}" needs a whole-number "width" of at least 1`);
    return { name, width: def.width, source: def.next };
  });
  const nState = stateDefs.reduce((s, st) => s + st.width, 0);
  if (nIn < 1 && nState < 1) throw new ExprError("there must be at least one input or state value");
  if (nIn + nState > maxInputBits) {
    throw new ExprError(`the inputs${nState ? " and state" : ""} add up to ${nIn + nState} bits; every combination is checked, so they must total 1..${maxInputBits}`);
  }

  const env = new Map();
  const seen = new Set();
  const claim = (name, what) => {
    if (typeof name !== "string" || !IDENT.test(name) || RESERVED.has(name)) throw new ExprError(`${what} name ${JSON.stringify(name)} must be a plain identifier`);
    if (seen.has(name)) throw new ExprError(`the name "${name}" is used twice`);
    seen.add(name);
  };
  for (const i of inputs) { claim(i.name, "input"); env.set(i.name, [0n, pow2(i.width) - 1n]); }
  for (const st of stateDefs) { claim(st.name, "state"); env.set(st.name, [0n, pow2(st.width) - 1n]); }

  const lets = entries(spec.let ?? {}, "let").map(([name, source]) => {
    claim(name, "let");
    const tree = parseExpression(source, `let "${name}"`);
    env.set(name, analyze(tree, env, `let "${name}"`));
    return { name, tree };
  });

  const outputs = entries(spec.outputs, "outputs").map(([name, def]) => {
    claim(name, "output");
    const d = typeof def === "string" ? { expr: def } : def;
    if (!d || typeof d.expr !== "string") throw new ExprError(`output "${name}" needs an "expr"`);
    if (!Number.isInteger(d.width) || d.width < 1) throw new ExprError(`output "${name}" needs a whole-number "width" of at least 1; its value is taken modulo 2^width`);
    const tree = parseExpression(d.expr, `output "${name}"`);
    analyze(tree, env, `output "${name}"`);
    return { name, width: d.width, tree };
  });
  if (outputs.length === 0) throw new ExprError("there must be at least one output");
  const nOut = outputs.reduce((s, o) => s + o.width, 0);
  if (nOut + nState > maxOutputBits) throw new ExprError(`the outputs${nState ? " and state" : ""} add up to ${nOut + nState} bits; the limit is ${maxOutputBits}`);
  const states = stateDefs.map((st) => {
    const where = `state "${st.name}" next`;
    const tree = parseExpression(st.source, where);
    analyze(tree, env, where);
    return { name: st.name, width: st.width, tree };
  });
  const examples = parseExamples(spec.examples, inputs, outputs, states);
  return { inputs, states, lets, outputs, nIn, nState, nOut, examples };
}

// Examples are the program's own tests, written the way a person checks a behaviour: "given
// these inputs, expect these outputs". Every input must be given; any subset of outputs may be
// expected. They are checked against the program before anything is compiled.
//
//   "examples": [ { "given": { "a": 3, "b": 5 }, "expect": { "larger": 5 } } ]
//
// With state, "given" also holds the current state (0 when left out: power-on), and "then"
// the state expected after the tick. An example needs "expect", "then", or both.
export const MAX_EXAMPLES = 64;
function parseExamples(value, inputs, outputs, states) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ExprError(`"examples" must be a list of { "given": {...}, "expect": {...} }`);
  if (value.length > MAX_EXAMPLES) throw new ExprError(`at most ${MAX_EXAMPLES} examples`);
  const widths = (list) => new Map(list.map((f) => [f.name, f.width]));
  const inW = widths([...inputs, ...states]), outW = widths(outputs), stW = widths(states);
  return value.map((e, k) => {
    const where = `example ${k + 1}`;
    const object = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (!object(e) || !object(e.given) || (e.expect !== undefined && !object(e.expect)) || (e.then !== undefined && !object(e.then))) {
      throw new ExprError(`needs a "given" object and an "expect"${states.length ? " or \"then\"" : ""} object`, where);
    }
    const read = (obj, known, what) => Object.entries(obj).map(([name, v]) => {
      if (!known.has(name)) throw new ExprError(`"${name}" is not ${what}`, where);
      const max = 2 ** known.get(name) - 1;
      if (!Number.isInteger(v) || v < 0 || v > max) throw new ExprError(`${name} = ${JSON.stringify(v)} must be a whole number 0..${max}`, where);
      return [name, v];
    });
    const given = Object.fromEntries(read(e.given, inW, states.length ? "an input or state" : "an input"));
    for (const i of inputs) if (!(i.name in given)) throw new ExprError(`gives no value for input "${i.name}"`, where);
    for (const st of states) if (!(st.name in given)) given[st.name] = 0;
    const expect = Object.fromEntries(read(e.expect ?? {}, outW, "an output"));
    const then = Object.fromEntries(read(e.then ?? {}, stW, "a state"));
    if (Object.keys(expect).length === 0 && Object.keys(then).length === 0) throw new ExprError(states.length ? `expects no output and no next state` : `expects no output`, where);
    return Object.keys(then).length ? { given, expect, then } : { given, expect };
  });
}

// The outputs a program gives for named input values, by the reference semantics.
// The outputs for named input (and current state) values; with raw, the exact BigInt values
// before each output is cut to its width. runStep also gives the next state.
export function runProgram(program, given, { raw = false } = {}) {
  return step(program, given, raw).outputs;
}
export function runStep(program, given) {
  return step(program, given, false);
}
function step(program, given, raw) {
  const env = new Map();
  for (const f of [...program.inputs, ...(program.states ?? [])]) env.set(f.name, BigInt(given[f.name] ?? 0) & (pow2(f.width) - 1n));
  for (const l of program.lets) env.set(l.name, evaluate(l.tree, env));
  const cut = (f) => {
    const v = evaluate(f.tree, env);
    return [f.name, raw ? v : Number(v & (pow2(f.width) - 1n))];
  };
  return { outputs: Object.fromEntries(program.outputs.map(cut)), next: Object.fromEntries((program.states ?? []).map(cut)) };
}

// Every example the program gets wrong, with what it gives instead.
export function exampleFailures(program) {
  const failures = [];
  program.examples.forEach((e, k) => {
    const { outputs, next } = runStep(program, e.given);
    const wrong = Object.keys(e.expect).filter((name) => outputs[name] !== e.expect[name]);
    const wrongNext = Object.keys(e.then ?? {}).filter((name) => next[name] !== e.then[name]);
    if (wrong.length || wrongNext.length) failures.push({ index: k, given: e.given, expect: e.expect, then: e.then, got: outputs, gotNext: next, wrong, wrongNext });
  });
  return failures;
}

const pairs = (obj, names = Object.keys(obj)) => names.map((n) => `${n}=${obj[n]}`).join(" ");
export function describeFailure(f) {
  const wrongNext = f.wrongNext ?? [];
  const expected = [f.wrong.length ? pairs(f.expect, f.wrong) : "", wrongNext.length ? `next ${pairs(f.then, wrongNext)}` : ""].filter(Boolean).join(", ");
  const got = [f.wrong.length ? pairs(f.got, f.wrong) : "", wrongNext.length ? `next ${pairs(f.gotNext, wrongNext)}` : ""].filter(Boolean).join(", ");
  return `example ${f.index + 1}: given ${pairs(f.given)}, expected ${expected} but the program gives ${got}`;
}

// The table a program denotes: every row, by the reference semantics above.
// Row = inputs | state << nIn, both packed least significant bit first in declaration order;
// value = outputs | next state << nOut, the layout compileTable takes.
export function programTable(program) {
  const { inputs, lets, outputs, nIn, nOut } = program;
  const states = program.states ?? [];
  const nState = program.nState ?? 0;
  const ys = new Uint32Array(2 ** (nIn + nState));
  const env = new Map();
  const fields = [...inputs, ...states];
  for (let row = 0; row < ys.length; row++) {
    let shift = 0;
    for (const f of fields) { env.set(f.name, BigInt((row >>> shift) & (2 ** f.width - 1))); shift += f.width; }
    for (const l of lets) env.set(l.name, evaluate(l.tree, env));
    let y = 0n, at = 0n;
    for (const f of [...outputs, ...states]) { y |= (evaluate(f.tree, env) & (pow2(f.width) - 1n)) << at; at += BigInt(f.width); }
    ys[row] = Number(y);
  }
  return { nIn, nState, nOut, ys };
}

// A plain "fn" in x over nIn bits with an nOut-bit result, read as a program, when the
// expression language can express it. Returns null otherwise: the table path still compiles it.
export function programFromFn(fn, nIn, nOut) {
  try {
    return parseProgram({ inputs: { x: nIn }, outputs: { y: { width: nOut, expr: fn } } });
  } catch {
    return null;
  }
}
