// A program read back in plain words, so a person who did not write it - or who had a model
// write it - can check it says what they meant without reading operator syntax. Also warns
// where an output is narrower than the values its expression can take, the one silent way a
// program differs from arithmetic on paper.
import { runProgram } from "./expr.mjs";

const WORDS = {
  en: {
    "+": "plus", "-": "minus", "*": "times", "/": "divided by (rounded down)", "%": "remainder after dividing by",
    "<": "is less than", "<=": "is at most", ">": "is greater than", ">=": "is at least", "==": "equals", "!=": "is not equal to",
    "&&": "and", "||": "or", "&": "bitwise-and", "|": "bitwise-or", "^": "bitwise-xor",
    "<<": "shifted left by", ">>": "shifted right by", ">>>": "shifted right by",
    not: (x) => `not ${x}`, neg: (x) => `minus ${x}`, inv: (x) => `every bit of ${x} flipped`,
    ifThen: (c, y, n) => `if ${c} then ${y}, otherwise ${n}`,
    bit: (x, i) => `bit ${i} of ${x}`, bits: (x, hi, lo) => `bits ${hi} to ${lo} of ${x}`,
    input: (name, w, max) => `${name}: an input of ${w} bit${w === 1 ? "" : "s"}, 0 to ${max}`,
    let: (name, text) => `${name} means: ${text}`,
    output: (name, w, text) => `${name} (${w} bit${w === 1 ? "" : "s"}) = ${text}`,
    state: (name, w, max) => `${name}: remembered, ${w} bit${w === 1 ? "" : "s"}, 0 to ${max}, 0 at power-on`,
    next: (name, w, text) => `after each tick, ${name} becomes ${text}`,
    truncated: (name, w, lo, hi, exact) => `${name} ${exact ? "reaches" : "can be"} ${lo} to ${hi} before it is cut to ${w} bit${w === 1 ? "" : "s"}; ${lo < 0 ? "negative values wrap around, and " : ""}only the lowest ${w} bit${w === 1 ? " is" : "s are"} kept.`,
    open: "(", close: ")",
  },
  zh: {
    "+": "加", "-": "减", "*": "乘", "/": "除以（向下取整）", "%": "除以后的余数，除数是",
    "<": "小于", "<=": "不大于", ">": "大于", ">=": "不小于", "==": "等于", "!=": "不等于",
    "&&": "并且", "||": "或者", "&": "按位与", "|": "按位或", "^": "按位异或",
    "<<": "左移位数", ">>": "右移位数", ">>>": "右移位数",
    not: (x) => `不是 ${x}`, neg: (x) => `负 ${x}`, inv: (x) => `${x} 每一位取反`,
    ifThen: (c, y, n) => `如果 ${c}，就是 ${y}，否则 ${n}`,
    bit: (x, i) => `${x} 的第 ${i} 位`, bits: (x, hi, lo) => `${x} 的第 ${hi} 到 ${lo} 位`,
    input: (name, w, max) => `${name}：输入，${w} 位，0 到 ${max}`,
    let: (name, text) => `${name} 表示：${text}`,
    output: (name, w, text) => `${name}（${w} 位）= ${text}`,
    state: (name, w, max) => `${name}：记住的状态，${w} 位，0 到 ${max}，开机时是 0`,
    next: (name, w, text) => `每一拍之后，${name} 变成 ${text}`,
    truncated: (name, w, lo, hi, exact) => `${name} 算出来${exact ? "会" : "可能"}是 ${lo} 到 ${hi}，但只有 ${w} 位：${lo < 0 ? "负数会回绕，" : ""}只保留最低 ${w} 位。`,
    open: "（", close: "）",
  },
};

// Loosest-binding first, as in the parser; used only to decide where words need grouping.
const LEVEL = { "?:": 0, "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, "<=": 7, ">": 7, ">=": 7, "<<": 8, ">>": 8, ">>>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };

// Words have no precedence, so a reader cannot tell "a or b and c" apart from "(a or b) and c".
// A binary child is grouped whenever its reading could be in doubt: a looser operator, a
// logical or bitwise one inside another operator, or two different arithmetic levels. A left
// operand of the same operator is left ungrouped, since "a plus b plus c" reads correctly.
function needsGroup(child, parentOp, left) {
  const cl = LEVEL[child.op];
  if (cl === undefined || child.op === "?:") return child.op === "?:";
  if (child.op === parentOp && left && parentOp !== "-" && parentOp !== "/" && parentOp !== "%") return false;
  const pl = LEVEL[parentOp] ?? 11;
  if (cl <= pl) return true;
  if (cl <= 5) return true;
  return cl >= 8 && pl >= 8;
}

function phrase(node, w) {
  const group = (child, left = true) => {
    const text = phrase(child, w);
    return needsGroup(child, node.op, left) ? `${w.open}${text}${w.close}` : text;
  };
  switch (node.op) {
    case "num": return String(node.value);
    case "name": return node.name;
    case "!": return w.not(group(node.args[0]));
    case "neg": return w.neg(group(node.args[0]));
    case "~": return w.inv(group(node.args[0]));
    case "?:": return w.ifThen(group(node.args[0]), group(node.args[1]), group(node.args[2]));
    case "slice": {
      const x = group(node.args[0]);
      return node.hi === node.lo ? w.bit(x, node.hi) : w.bits(x, node.hi, node.lo);
    }
    default: return `${group(node.args[0], true)} ${w[node.op]} ${group(node.args[1], false)}`;
  }
}

// The smallest and largest value an output's expression really takes, before it is cut to its
// width: exact over every row for tables up to EXACT_ROWS, otherwise the analyser's interval,
// which can be wider than the truth (the warning then says "can be", not "is").
const EXACT_ROWS = 1 << 16;
function outputRanges(program) {
  if (2 ** (program.nIn + (program.nState ?? 0)) > EXACT_ROWS) return { exact: false, ranges: program.outputs.map((o) => o.tree.range) };
  const ranges = program.outputs.map(() => [null, null]);
  const given = {};
  const fields = [...program.inputs, ...(program.states ?? [])];
  for (let row = 0; row < 2 ** (program.nIn + (program.nState ?? 0)); row++) {
    let shift = 0;
    for (const i of fields) { given[i.name] = Math.floor(row / 2 ** shift) % 2 ** i.width; shift += i.width; }
    const raw = runProgram(program, given, { raw: true });
    program.outputs.forEach((o, k) => {
      const v = raw[o.name];
      if (ranges[k][0] === null || v < ranges[k][0]) ranges[k][0] = v;
      if (ranges[k][1] === null || v > ranges[k][1]) ranges[k][1] = v;
    });
  }
  return { exact: true, ranges };
}

export function explainProgram(program, lang = "en") {
  const w = WORDS[lang] ?? WORDS.en;
  const lines = [];
  for (const i of program.inputs) lines.push(w.input(i.name, i.width, 2 ** i.width - 1));
  for (const st of program.states ?? []) lines.push(w.state(st.name, st.width, 2 ** st.width - 1));
  for (const l of program.lets) lines.push(w.let(l.name, phrase(l.tree, w)));
  const warnings = [];
  const { exact, ranges } = outputRanges(program);
  program.outputs.forEach((o, k) => {
    lines.push(w.output(o.name, o.width, phrase(o.tree, w)));
    const [lo, hi] = ranges[k];
    if (lo < 0n || hi > 2n ** BigInt(o.width) - 1n) warnings.push(w.truncated(o.name, o.width, lo, hi, exact));
  });
  for (const st of program.states ?? []) lines.push(w.next(st.name, st.width, phrase(st.tree, w)));
  const tidy = (text) => (lang === "zh" ? text.replace(/ ?（/g, "（").replace(/） ?/g, "）") : text);
  return { lines: lines.map(tidy), warnings: warnings.map(tidy), exact };
}

// A few rows to look at when a program has no examples: all zero, all at maximum, and two
// fixed in-between points, each with what the program gives.
export function sampleRows(program) {
  const at = (f) => Object.fromEntries([...program.inputs, ...(program.states ?? [])].map((i, k) => [i.name, f(2 ** i.width - 1, k)]));
  const candidates = [at(() => 0), at((max) => max), at((max, k) => Math.floor(max * (k % 2 ? 0.3 : 0.7))), at((max, k) => Math.floor(max * (k % 2 ? 0.8 : 0.2)))];
  const seen = new Set();
  return candidates.filter((given) => {
    const key = JSON.stringify(given);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((given) => ({ given, got: runProgram(program, given) }));
}
