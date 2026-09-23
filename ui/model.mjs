// The parts of the browser UI that do not need a page: editor data, the files
// and command that reproduce a compile, and diagram layout. Tested in Node.
import { MAX_INPUT_BITS, describeFailure, exampleFailures, parseProgram } from "../src/expr.mjs";
import { partition } from "../src/compose.mjs";
import { explainProgram } from "../src/explain.mjs";
import { OPCODE } from "../src/netlist.mjs";
import { reachableStates } from "../src/tables.mjs";

export const KINDS = ["expr", "grid", "table", "fsm"];
export const EDITABLE_ROWS = 64;
export const MAX_DRAWN_ELEMENTS = 240;

export const EXAMPLES = {
  expr: [{ id: "thermostat", file: "thermostat.expr.json" }, { id: "counter", file: "counter.expr.json" }, { id: "adder8", file: "adder8.expr.json" }],
  // Ready-made programs behind the everyday sentences on the first screen: picking one needs no model.
  flow: [
    { id: "vote", file: "vote.expr.json", sentence: { en: "Three people vote, one bit each; it passes when most say yes", zh: "三个人投票，每人一位，多数同意就通过" } },
    { id: "counter", file: "counter.expr.json", sentence: { en: "A button counter: each press adds 1, after 9 it goes back to 0", zh: "一个按钮计数器：每按一下加 1，到 9 之后回到 0" } },
    { id: "max", file: "max.expr.json", sentence: { en: "Two 4-bit numbers: output the larger one, and whether they are equal", zh: "两个 4 位数，输出较大的那个，以及它们是否相等" } },
    { id: "toggle", file: "toggle.expr.json", sentence: { en: "A lamp: press once to turn it on, press again to turn it off", zh: "一个灯：按一下亮，再按一下灭" } },
  ],
  grid: [{ id: "grid-demo", file: "grid-demo.map.json", labels: ["stay", "left", "right", "jump"] }],
  table: [{ id: "majority3", file: "majority3.table.json" }, { id: "adder4", file: "adder4.table.json" }],
  fsm: [{ id: "counter", file: "counter.fsm.json" }, { id: "traffic-light", file: "traffic-light.fsm.json" }],
};

export const bitsOf = (value, width) => Array.from({ length: width }, (_, i) => Math.floor(value / 2 ** i) % 2);
export const valueOf = (bits) => bits.reduce((sum, bit, i) => sum + (bit ? 2 ** i : 0), 0);

// 1500000000000000 wei -> "0.0015"
export function formatUnits(value, decimals = 18) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const fraction = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${v / base}.${fraction}` : `${v / base}`;
}

// Rows of a packed table (row x | s << nIn holds y | next << nOut) after a
// width changes: every (input, state) pair that still exists keeps the output
// and next-state bits that still fit; new rows start at 0.
export function resizeRows(old, shape) {
  const oldState = old.nState ?? 0;
  const nState = shape.nState ?? 0;
  const ys = new Array(2 ** (shape.nIn + nState)).fill(0);
  const states = 2 ** Math.min(oldState, nState);
  const inputs = 2 ** Math.min(old.nIn, shape.nIn);
  for (let s = 0; s < states; s++) {
    for (let x = 0; x < inputs; x++) {
      const v = old.ys[x + s * 2 ** old.nIn] ?? 0;
      const y = v % 2 ** old.nOut;
      const next = Math.floor(v / 2 ** old.nOut);
      ys[x + s * 2 ** shape.nIn] = (y % 2 ** shape.nOut) + (next % 2 ** nState) * 2 ** shape.nOut;
    }
  }
  return ys;
}

// An expression program as the editor holds it: ordered rows, so a half-typed
// name or a duplicate survives editing. Rows with nothing in them are ignored.
// Examples are one line each, "a=3 b=5 -> larger=5 same=0".
const pairsText = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(" ");
export const exampleLine = (e) => {
  const expect = pairsText(e.expect ?? {});
  const then = e.then && Object.keys(e.then).length ? `then ${pairsText(e.then)}` : "";
  return `${pairsText(e.given)} -> ${[expect, then].filter(Boolean).join(" ")}`;
};

export function parseExampleLine(line) {
  const parts = line.split(/->|=>|→/);
  if (parts.length !== 2) throw new Error(`"${line.trim()}" needs one arrow: inputs -> outputs, e.g. a=3 b=5 -> larger=5`);
  const side = (text) => {
    const out = {};
    for (const item of text.split(/[\s,，;；]+/).filter(Boolean)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)[=:：](0|[1-9][0-9]*|0x[0-9a-fA-F]+|0b[01]+)$/.exec(item);
      if (!m) throw new Error(`"${item}" in "${line.trim()}" should look like name=number`);
      out[m[1]] = Number(m[2]);
    }
    return out;
  };
  // "-> out=1 then count=2": the state after the tick follows "then" (or 然后 / 之后)
  const [expectText, thenText, extra] = parts[1].split(/\bthen\b|然后|之后/);
  if (extra !== undefined) throw new Error(`"${line.trim()}" has more than one "then"`);
  const result = { given: side(parts[0]), expect: side(expectText) };
  if (thenText !== undefined) result.then = side(thenText);
  return result;
}

export function exprEditorFrom(spec) {
  const pairs = (value) => Object.entries(value ?? {});
  return {
    inputs: pairs(spec.inputs).map(([name, width]) => ({ name, width })),
    states: pairs(spec.state).map(([name, def]) => ({ name, width: def.width, expr: def.next })),
    lets: pairs(spec.let).map(([name, expr]) => ({ name, expr })),
    outputs: pairs(spec.outputs).map(([name, def]) => ({ name, width: def.width, expr: def.expr })),
    examples: Array.isArray(spec.examples) ? spec.examples.map((e) => ({ text: exampleLine(e) })) : [],
  };
}

export function exprSpec(editor) {
  const seen = new Set();
  const keep = (row) => row.name.trim() || (row.expr ?? "").trim();
  const named = (row) => {
    const name = row.name.trim();
    if (seen.has(name)) throw new Error(`the name "${name}" is used twice`);
    seen.add(name);
    return name;
  };
  const inputs = {};
  for (const row of editor.inputs.filter(keep)) inputs[named(row)] = row.width;
  const states = {};
  for (const row of (editor.states ?? []).filter(keep)) states[named(row)] = { width: row.width, next: row.expr };
  const lets = {};
  for (const row of editor.lets.filter(keep)) lets[named(row)] = row.expr;
  const outputs = {};
  for (const row of editor.outputs.filter(keep)) outputs[named(row)] = { width: row.width, expr: row.expr };
  const spec = { inputs };
  if (Object.keys(states).length) spec.state = states;
  if (Object.keys(lets).length) spec.let = lets;
  spec.outputs = outputs;
  const examples = (editor.examples ?? []).filter((e) => e.text.trim()).map((e) => parseExampleLine(e.text));
  if (examples.length) spec.examples = examples;
  return spec;
}

// What the editor's program would compile to, or why it cannot: checked the same way the
// compiler checks it, before a compile is started. Also each example's verdict (by editor
// row, blank rows null) and the program read back in words.
export function exprStatus(editor, lang = "en") {
  const rows = (editor.examples ?? []).map(() => null);
  try {
    const spec = exprSpec(editor);
    // A program past one proof is not a mistake here: the compiler offers to cut it into
    // blocks, so the editor accepts it when the cut would work, and otherwise reports what
    // the partition reports - which name reads too much, and the "let" that would fix it.
    const program = parseProgram(spec, { wide: true });
    const wide = program.nIn + program.nState > MAX_INPUT_BITS;
    if (wide) partition(program);
    const failures = new Map(exampleFailures(program).map((f) => [f.index, f]));
    let k = 0;
    (editor.examples ?? []).forEach((e, i) => {
      if (!e.text.trim()) return;
      const f = failures.get(k++);
      rows[i] = f ? { ok: false, message: describeFailure(f) } : { ok: true };
    });
    const bad = failures.size;
    return {
      ok: bad === 0,
      message: bad ? `${bad} of ${program.examples.length} examples do not hold` : undefined,
      nIn: program.nIn, nState: program.nState, nOut: program.nOut, rows: 2 ** (program.nIn + program.nState), wide,
      examples: rows,
      examplesHold: program.examples.length - bad,
      explain: explainProgram(program, lang),
    };
  } catch (error) {
    return { ok: false, message: error.message, examples: rows };
  }
}

// What the page remembers between visits: the circuits already built, newest first, one entry
// per name-and-program. An entry carries enough to bring the circuit back exactly (the spec,
// the seed and the steps the certificate recorded), not the circuit itself.
export const HISTORY_LIMIT = 24;

export function historyEntry({ name, sentence, spec, certificate, at = Date.now() }) {
  return {
    at,
    name,
    sentence: (sentence ?? "").trim(),
    spec,
    seed: certificate.reproduce.seed,
    steps: certificate.reproduce.steps,
    objective: certificate.reproduce.objective ?? "gates",
    nand: certificate.circuit.nand,
    latch: certificate.circuit.latch,
    rows: certificate.verification.rowsChecked,
    netlistSha256: certificate.circuit.netlistSha256,
  };
}

export function rememberCircuit(history, entry, limit = HISTORY_LIMIT) {
  const same = (a, b) => a.name === b.name && JSON.stringify(a.spec) === JSON.stringify(b.spec);
  return [entry, ...history.filter((old) => !same(old, entry))].slice(0, limit);
}

// Diagram pin labels for a compiled expression program: input bits x0.., latch bits s0.. and
// output bits y0.. named after the program, with the bit index when a value has several bits.
export function pinNames(expression) {
  const expand = (fields = []) => fields.flatMap((f) => Array.from({ length: f.width }, (_, i) => (f.width === 1 ? f.name.slice(0, 4) : `${f.name.slice(0, i > 9 ? 2 : 3)}${i}`)));
  return { x: expand(expression.inputs), s: expand(expression.state), y: expand(expression.outputs) };
}

// Named input values packed into an input row (least significant bit first, in
// declaration order), and an output row split back into named values.
export function packFields(fields, values) {
  let row = 0;
  let at = 0;
  fields.forEach((f, i) => {
    row += (values[i] % 2 ** f.width) * 2 ** at;
    at += f.width;
  });
  return row;
}

export function unpackFields(fields, row) {
  let at = 0;
  return fields.map((f) => {
    const v = Math.floor(row / 2 ** at) % 2 ** f.width;
    at += f.width;
    return v;
  });
}

// The spec a command-line compiler takes for what the editor holds.
export function specFor(kind, editor) {
  if (kind === "expr") return exprSpec(editor);
  if (kind === "grid") return { map: editor.map.map((row) => [...row]) };
  if (kind === "table") return { nIn: editor.nIn, nOut: editor.nOut, rows: editor.ys.map((y, x) => [x, y]) };
  if (kind === "fsm") {
    const { nIn, nState, nOut, ys } = editor;
    const rows = [];
    for (let s = 0; s < 2 ** nState; s++) {
      for (let x = 0; x < 2 ** nIn; x++) {
        const v = ys[x + s * 2 ** nIn];
        rows.push([x, s, v % 2 ** nOut, Math.floor(v / 2 ** nOut)]);
      }
    }
    return { nIn, nState, nOut, rows };
  }
  throw new Error(`unknown kind ${kind}`);
}

const SPEC_SUFFIX = { expr: "expr.json", grid: "map.json", table: "table.json", fsm: "fsm.json" };
export const specFileName = (kind, name) => `${name}.${SPEC_SUFFIX[kind]}`;

export function specText(kind, spec) {
  if (kind === "expr") return `${JSON.stringify(spec, null, 2)}\n`;
  if (kind === "grid") return `[\n${spec.map.map((row) => ` ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
  const { rows, ...shape } = spec;
  return `${JSON.stringify(shape).slice(0, -1)},\n "rows": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(",\n")}\n ]\n}\n`;
}

const shellWord = (text) => (/^[A-Za-z0-9._,:/=-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

// The command that rebuilds a compile from its downloaded spec file, byte for byte.
export function cliCommand(kind, { name, labels, seed, steps, objective }) {
  const file = specFileName(kind, name);
  const common = `--name ${name} --seed ${seed} --steps ${steps}${objective === "cost" ? " --objective cost" : ""}`;
  if (kind === "grid") return `node scripts/compile-grid.mjs --map ${file} --labels ${shellWord(labels.join(","))} ${common}`;
  if (kind === "table") return `node scripts/compile-table.mjs --table ${file} ${common}`;
  if (kind === "expr") return `node scripts/compile-expr.mjs --spec ${file} ${common}`;
  return `node scripts/compile-fsm.mjs --spec ${file} ${common}`;
}

// Why a set of grid choice names cannot be used (a string key), or null.
export function labelProblem(labels) {
  if (labels.some((label) => !label)) return "labelEmpty";
  if (labels.some((label) => label.includes(","))) return "labelComma";
  if (new Set(labels).size !== labels.length) return "labelDuplicate";
  return null;
}

// Transitions of a state machine grouped by (from, to), with the input/output
// pairs that take each one.
export function stateGraph(table) {
  const { nIn, nState, nOut, ys } = table;
  const groups = new Map();
  for (let s = 0; s < 2 ** nState; s++) {
    for (let x = 0; x < 2 ** nIn; x++) {
      const v = ys[x + s * 2 ** nIn];
      const next = Math.floor(v / 2 ** nOut);
      const key = `${s}:${next}`;
      if (!groups.has(key)) groups.set(key, { from: s, to: next, cases: [] });
      groups.get(key).cases.push({ x, y: v % 2 ** nOut });
    }
  }
  return { states: 2 ** nState, edges: [...groups.values()], reachable: new Set(reachableStates(table)) };
}

const COLUMN = 78;
const ROW = 30;
const PAD = 26;
const PORT = { nand: 11, other: 14 };

// Left-to-right drawing of a flat netlist: inputs, constants and latch outputs
// in the first column, each NAND one column right of its deeper operand,
// outputs last. Rows inside a column follow the average height of what feeds
// them, which keeps most wires short. Returns null for circuits too big to read.
export function diagramLayout(circuit) {
  const { nIn, elements, outputs } = circuit;
  if (elements.length > MAX_DRAWN_ELEMENTS) return null;
  const used = new Set(outputs);
  for (const e of elements) {
    if (e.op === OPCODE.NAND) {
      used.add(e.a);
      used.add(e.b);
    } else if (e.op === OPCODE.LATCH) {
      used.add(e.d);
    } else {
      throw new Error("REF elements are not drawn");
    }
  }

  const bySignal = new Map();
  const columns = [[]];
  const add = (node, column) => {
    node.column = column;
    (columns[column] ??= []).push(node);
    if (node.signal !== undefined) bySignal.set(node.signal, node);
  };
  for (const c of [0, 1]) if (used.has(c)) add({ kind: "const", signal: c, label: String(c) }, 0);
  for (let i = 0; i < nIn; i++) add({ kind: "input", signal: 2 + i, label: `x${i}` }, 0);
  let latch = 0;
  for (const e of elements) if (e.op === OPCODE.LATCH) add({ kind: "latch", signal: e.out, label: `s${latch++}`, d: e.d }, 0);
  for (const e of elements) {
    if (e.op === OPCODE.NAND) add({ kind: "nand", signal: e.out, a: e.a, b: e.b }, Math.max(bySignal.get(e.a).column, bySignal.get(e.b).column) + 1);
  }
  const outColumn = columns.length;
  outputs.forEach((source, k) => add({ kind: "output", source, label: `y${k}` }, outColumn));

  const tallest = Math.max(...columns.map((column) => column.length));
  const place = (column) => column.forEach((node, i) => { node.y = PAD + ((tallest - column.length) / 2 + i) * ROW; });
  place(columns[0]);
  const height = (node) => (node.kind === "output" ? bySignal.get(node.source).y : (bySignal.get(node.a).y + bySignal.get(node.b).y) / 2);
  for (let c = 1; c < columns.length; c++) {
    columns[c].sort((p, q) => height(p) - height(q));
    place(columns[c]);
  }
  const nodes = columns.flat();
  for (const node of nodes) node.x = PAD + 22 + node.column * COLUMN;

  const wire = (source, target, dy, feedback = false) => ({
    x1: source.x + PORT.other,
    y1: source.y,
    x2: target.x - (target.kind === "nand" ? PORT.nand : PORT.other),
    y2: target.y + dy,
    signal: source.signal,
    feedback,
  });
  const edges = [];
  for (const node of nodes) {
    if (node.kind === "nand") edges.push(wire(bySignal.get(node.a), node, -5), wire(bySignal.get(node.b), node, 5));
    else if (node.kind === "latch") edges.push(wire(bySignal.get(node.d), node, 0, true));
    else if (node.kind === "output") edges.push(wire(bySignal.get(node.source), node, 0));
  }
  return {
    width: PAD * 2 + 44 + (columns.length - 1) * COLUMN,
    height: Math.max(PAD * 2 + (tallest - 1) * ROW, 60),
    nodes,
    edges,
  };
}

// When the gate asks for the one thing it is missing, the answer becomes part of the sentence
// rather than a hidden setting. Two reasons: the program the model writes next sees it, and
// the person can read exactly what their answer turned into - and edit it if it is not what
// they meant. The question mark is dropped so the sentence still reads as a sentence.
export function gateAnswerSentence(sentence, question, answer) {
  const said = String(answer ?? "").trim();
  if (!said) return String(sentence ?? "");
  const asked = String(question ?? "").trim().replace(/[？?]+$/, "");
  return asked ? `${sentence}（${asked}：${said}）` : `${sentence}（${said}）`;
}
