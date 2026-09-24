// The browser front end: describe a behaviour, compile it in a worker, read the
// proof, try the circuit, and build an unsigned tape-out plan. Served by
// scripts/ui.mjs; everything runs on this computer.
import { probeKey, renderDecide, useDiagram, useModel } from "./decide.mjs";
import { PROVIDERS, askModel, askModelBestOf, describePrompt, findLocalModel, modelRequest, questionFromReply, specFromReply } from "../src/describe.mjs";
import { feasibility, refusalWords, signalsFromReply, signalsPrompt } from "../src/feasible.mjs";
import { everMoves, narrate } from "../src/narrate.mjs";
import { MAX_INPUT_BITS, parseProgram } from "../src/expr.mjs";
import { forkFromReply, forkPrompt, knobsFromReply, knobsPrompt, safeKnobs } from "../src/route.mjs";
import { chainCheck } from "../src/chaincheck.mjs";
import { FIRSTO_FLOW_URL } from "../src/handoff.mjs";
import { TEMPLATES, fromTemplate, templateDefaults } from "../src/templates.mjs";
import { decodeCircuit, hexToBytes, simulate } from "../src/netlist.mjs";
import { parseSeed } from "../src/rng.mjs";
import { combinationalTable, fsmTable, gridTable } from "../src/tables.mjs";
import { planTapeout, readChain, simulatePlan } from "../src/tapeout.mjs";
import { EDITABLE_ROWS, EXAMPLES, KINDS, bitsOf, cliCommand, diagramLayout, exprEditorFrom, exprSpec, exprStatus, formatUnits, gateAnswerSentence, historyEntry, labelProblem, packFields, pinNames, rememberCircuit, resizeRows, specFileName, specFor, specText, stateGraph, unpackFields, valueOf } from "./model.mjs";
import { STRINGS } from "./strings.mjs";

const SAVE_KEY = "gatecraft.ui/1";
// The model API key lives in memory only, unless the user ticks "remember"; then it is kept
// apart from the rest of the saved state, in this browser alone.
const API_KEY_SLOT = "gatecraft.ui/api-key";
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SVG_NS = "http://www.w3.org/2000/svg";

// ---- DOM helpers ------------------------------------------------------------

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "style") Object.assign(el.style, value);
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

const $ = (selector) => document.querySelector(selector);

// replaceChildren() for lists that may hold null or false: those are skipped, not printed.
function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

function t(key, ...args) {
  const value = STRINGS[state.lang][key] ?? STRINGS.en[key] ?? key;
  return typeof value === "function" ? value(...args) : value;
}

const num = (n) => Number(n).toLocaleString(state.lang === "zh" ? "zh-CN" : "en-US");

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function copyButton(label, text) {
  const button = h("button", { type: "button", class: "ghost" }, label);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = t("copied");
      setTimeout(() => { button.textContent = label; }, 1200);
    } catch {
      button.textContent = "×";
    }
  });
  return button;
}

function bitButton(get, toggle, title) {
  const button = h("button", { type: "button", class: "bit", disabled: !toggle, title });
  const paint = () => {
    const v = get();
    button.textContent = v;
    button.classList.toggle("one", v === 1);
  };
  paint();
  if (toggle) button.addEventListener("click", () => { toggle(); paint(); });
  return button;
}

const pair = (label, value) => [h("dt", {}, label), h("dd", {}, value)];

// ---- state ------------------------------------------------------------------

function blank() {
  return {
    version: 1,
    seeded: false,
    // The decision flow is what a stranger should land on. The other view - a sentence turned
    // into a circuit - is the one this project's own data put at 3% of what people actually ask
    // for (docs/findings.md), so it is a workbench you switch to, not the front door.
    view: "decide",
    lang: (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en",
    kind: "expr",
    expr: {
      inputs: [{ name: "a", width: 4 }, { name: "b", width: 4 }],
      lets: [],
      outputs: [{ name: "sum", width: 5, expr: "a + b" }, { name: "bigger", width: 4, expr: "a > b ? a : b" }],
      examples: [{ text: "a=3 b=5 -> sum=8 bigger=5" }],
    },
    describe: { sentence: "", reply: "", provider: "anthropic", baseUrl: "", model: "" },
    history: [],
    last: null,
    grid: { map: Array.from({ length: 16 }, () => new Array(16).fill(0)), labels: ["A", "B", "C", "D"], brush: 1, fn: "" },
    table: { nIn: 3, nOut: 1, ys: new Array(8).fill(0), fn: "" },
    fsm: { nIn: 1, nState: 2, nOut: 1, ys: new Array(8).fill(0), fn: "" },
    compile: { names: { expr: "", grid: "", table: "", fsm: "" }, steps: "", seed: "", objective: "gates" },
    plan: { rpc: "", processor: "", from: "", chainId: "56", implementation: "", circuits: "", circuitId: "" },
  };
}

const LIMITS = { table: { nIn: [1, 20], nOut: [1, 16] }, fsm: { nIn: [1, 8], nState: [1, 4], nOut: [1, 8] } };

function sanitize(saved) {
  const out = blank();
  if (saved?.version !== 1) return out;
  if (["zh", "en"].includes(saved.lang)) out.lang = saved.lang;
  if (KINDS.includes(saved.kind)) out.kind = saved.kind;
  out.seeded = saved.seeded === true;
  if (["flow", "workbench", "gallery", "decide"].includes(saved.view)) out.view = saved.view;
  const choice = (v) => [0, 1, 2, 3].includes(v);
  const g = saved.grid;
  if (g?.map?.length === 16 && g.map.every((row) => row?.length === 16 && row.every(choice)) && g.labels?.length === 4 && g.labels.every((l) => typeof l === "string")) {
    out.grid = { map: g.map, labels: g.labels, brush: choice(g.brush) ? g.brush : 1, fn: typeof g.fn === "string" ? g.fn : "" };
  }
  const x = saved.expr;
  const text = (v) => typeof v === "string";
  const width = (v) => Number.isInteger(v) && v >= 0 && v <= 64;
  if (x && [x.inputs, x.lets, x.outputs].every(Array.isArray)
    && x.inputs.every((r) => text(r?.name) && width(r.width))
    && x.lets.every((r) => text(r?.name) && text(r.expr))
    && x.outputs.every((r) => text(r?.name) && width(r.width) && text(r.expr))) {
    out.expr = {
      inputs: x.inputs.map(({ name, width: w }) => ({ name, width: w })),
      states: Array.isArray(x.states) && x.states.every((r) => text(r?.name) && width(r.width) && text(r.expr))
        ? x.states.map(({ name, width: w, expr }) => ({ name, width: w, expr }))
        : [],
      lets: x.lets.map(({ name, expr }) => ({ name, expr })),
      outputs: x.outputs.map(({ name, width: w, expr }) => ({ name, width: w, expr })),
      examples: Array.isArray(x.examples) ? x.examples.filter((e) => text(e?.text)).map((e) => ({ text: e.text })) : [],
    };
  }
  for (const kind of ["table", "fsm"]) {
    const e = saved[kind];
    const inRange = e && Object.entries(LIMITS[kind]).every(([key, [lo, hi]]) => Number.isInteger(e[key]) && e[key] >= lo && e[key] <= hi);
    if (inRange && Array.isArray(e.ys) && e.ys.length === 2 ** (e.nIn + (e.nState ?? 0)) && e.ys.every((v) => Number.isInteger(v) && v >= 0)) {
      out[kind] = { ...out[kind], ...e, fn: typeof e.fn === "string" ? e.fn : "" };
    }
  }
  for (const section of ["compile", "plan", "describe"]) {
    for (const key of Object.keys(out[section])) if (typeof saved[section]?.[key] === "string") out[section][key] = saved[section][key];
  }
  for (const kind of KINDS) if (typeof saved.compile?.names?.[kind] === "string") out.compile.names[kind] = saved.compile.names[kind];
  if (!["gates", "cost"].includes(out.compile.objective)) out.compile.objective = "gates";
  if (!(out.describe.provider in PROVIDERS)) out.describe.provider = "anthropic";
  if (Array.isArray(saved.history)) {
    out.history = saved.history.filter((e) => e && typeof e.name === "string" && e.spec && typeof e.spec === "object" && Number.isInteger(e.nand)).slice(0, 24);
  }
  if (saved.last && typeof saved.last === "object" && saved.last.spec) out.last = saved.last;
  return out;
}

function load() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(SAVE_KEY)));
  } catch {
    return blank();
  }
}

const state = load();
const secret = { key: "", remember: false, asking: false };
try {
  const kept = JSON.parse(localStorage.getItem(API_KEY_SLOT));
  if (kept && typeof kept.key === "string" && kept.provider in PROVIDERS) Object.assign(secret, { key: kept.key, remember: true, provider: kept.provider });
} catch {
  // nothing kept, or storage blocked
}
function keepKey() {
  try {
    if (secret.remember && secret.key) localStorage.setItem(API_KEY_SLOT, JSON.stringify({ provider: state.describe.provider, key: secret.key }));
    else localStorage.removeItem(API_KEY_SLOT);
  } catch {
    // storage blocked: the key stays in memory for this visit
  }
}
const run = { worker: null, progress: null, started: 0, error: null, wide: null, result: null, sim: null, plan: null, api: null, localModel: null };

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch {
      // storage full or blocked: the page works without it
    }
  }, 250);
}

// Any change to the description the current proof was made from.
function edited() {
  save();
  if (run.result && !run.result.stale && run.result.kind === state.kind) {
    run.result.stale = true;
    renderProof();
  }
}

const defaultName = () => `my-${state.kind}`;

// ---- step 1: describe ---------------------------------------------------------

function renderTabs() {
  fill($("#tabs"), ...KINDS.map((kind) => h("button", {
    type: "button",
    class: "tab",
    role: "tab",
    "aria-selected": String(state.kind === kind),
    onclick: () => {
      state.kind = kind;
      save();
      renderTabs();
      renderEditor();
      renderCompileBar();
    },
  }, t(`kind_${kind}`))));
}

function renderEditor() {
  const editors = { expr: exprEditor, grid: gridEditor, table: tableEditor, fsm: fsmEditor };
  const body = editors[state.kind]();
  fill($("#editor"),
    h("p", { class: "hint" }, t(`hint_${state.kind}`)),
    h("div", { class: "toolbar" },
      h("span", { class: "muted" }, t(state.kind === "expr" ? "readyMade" : "examples")),
      EXAMPLES[state.kind].map((example) => h("button", {
        type: "button",
        class: "ghost",
        onclick: () => loadExample(state.kind, example).then(() => { renderEditor(); renderCompileBar(); }, showEditorError),
      }, example.id))),
    h("div", { class: "error", id: "editor-error", hidden: true }),
    body,
  );
}

function showEditorError(error) {
  const box = $("#editor-error");
  if (!box) return;
  box.textContent = error.message;
  box.hidden = false;
}

async function loadExample(kind, example) {
  const response = await fetch(new URL(`../examples/${example.file}`, import.meta.url));
  if (!response.ok) throw new Error(`${example.file}: HTTP ${response.status}`);
  const json = await response.json();
  if (kind === "expr") {
    const editor = exprEditorFrom(json);
    if (!exprStatus(editor).ok) throw new Error(`${example.file}: ${exprStatus(editor).message}`);
    state.expr = editor;
  } else if (kind === "grid") {
    gridTable({ map: json });
    Object.assign(state.grid, { map: json, labels: [...example.labels], fn: "" });
  } else if (kind === "table") {
    const table = combinationalTable(json);
    Object.assign(state.table, { nIn: table.nIn, nOut: table.nOut, ys: [...table.ys], fn: json.fn ?? "" });
  } else {
    const table = fsmTable(json);
    Object.assign(state.fsm, { nIn: table.nIn, nState: table.nState, nOut: table.nOut, ys: [...table.ys], fn: json.fn ?? "" });
  }
  state.compile.names[kind] = example.id;
  edited();
}

function expressionRow(kind, placeholder, apply) {
  const editor = state[kind];
  const go = () => {
    try {
      apply(editor.fn);
      edited();
      renderEditor();
    } catch (error) {
      showEditorError(error);
    }
  };
  return h("div", { class: "fnrow" },
    h("span", { class: "muted" }, t("expression")),
    h("input", {
      value: editor.fn,
      placeholder,
      spellcheck: "false",
      "aria-label": t("expression"),
      oninput: (e) => { editor.fn = e.target.value; save(); },
      onkeydown: (e) => { if (e.key === "Enter") go(); },
    }),
    h("button", { type: "button", onclick: go }, t("fill")));
}

function shapeInput(label, value, [min, max], onChange) {
  return h("label", { class: "field small" },
    h("span", {}, label),
    h("input", {
      type: "number",
      min,
      max,
      value: String(value),
      onchange: (e) => {
        const v = Number(e.target.value);
        if (!Number.isInteger(v) || v < min || v > max) {
          e.target.value = String(value);
          return;
        }
        onChange(v);
      },
    }));
}

function exprEditor() {
  const x = state.expr;
  const status = h("div", { class: "expr-status", role: "status" });
  const json = h("textarea", { class: "expr-json", rows: 10, spellcheck: "false", "aria-label": t("exprJson") });
  if (!x.examples) x.examples = [];
  if (!x.states) x.states = [];
  const verdicts = new Map();
  const readback = h("div", { class: "readback" });
  const friendly = h("ul", { class: "friendly-examples" });
  let timer = null;
  const refresh = () => {
    const st = exprStatus(x, state.lang);
    status.className = `expr-status ${st.ok ? "agree" : "disagree"}`;
    status.textContent = st.ok
      ? `✓ ${st.nIn + st.nState > MAX_INPUT_BITS ? t("exprOkWide", num(st.nIn + st.nState), MAX_INPUT_BITS) : st.nState ? t("exprOkState", num(st.nIn), num(st.nState), num(st.rows), num(st.nOut)) : t("exprOk", num(st.nIn), num(st.rows), num(st.nOut))}${st.examplesHold ? ` ${t("examplesHold", st.examplesHold)}` : ""}`
      : `✗ ${st.message}`;
    x.examples.forEach((row, i) => {
      const el = verdicts.get(row);
      if (!el) return;
      const v = st.examples[i];
      el.className = `verdict-mark ${v ? (v.ok ? "agree" : "disagree") : "muted"}`;
      el.textContent = v ? (v.ok ? "✓" : "✗") : "·";
      el.title = v?.message ?? "";
      el.parentElement.querySelector(".example-why").textContent = v && !v.ok ? v.message : "";
    });
    if (st.explain) {
      fill(readback,
        h("ul", { class: "readback-lines" }, st.explain.lines.map((line) => h("li", {}, line))),
        st.explain.warnings.map((warning) => h("p", { class: "stale small" }, `⚠ ${warning}`)));
    } else {
      fill(readback);
    }
    fill(friendly, x.examples.map((row, i) => {
      const v = st.examples[i];
      if (!row.text.trim()) return null;
      return h("li", { class: v ? (v.ok ? "agree" : "disagree") : "muted" },
        h("span", { class: "verdict-mark" }, v ? (v.ok ? "✓" : "✗") : "·"),
        h("span", { class: "mono" }, row.text.replace(/\s*->\s*/, "  →  ").replace(/\bthen\b/, t("thenWord"))),
        v && !v.ok ? h("div", { class: "small" }, v.message) : null);
    }));
    if (!x.examples.some((row) => row.text.trim())) fill(friendly, h("li", { class: "note" }, t("noExamplesYet")));
    if (document.activeElement !== json) {
      try {
        json.value = specText("expr", specFor("expr", x));
      } catch (error) {
        json.value = "";
      }
    }
  };
  const changed = () => { edited(); clearTimeout(timer); timer = setTimeout(refresh, 150); };
  const rebuild = () => { edited(); renderEditor(); };

  const nameInput = (row) => h("input", {
    class: "mono expr-name",
    value: row.name,
    placeholder: t("exprName"),
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": t("exprName"),
    oninput: (e) => { row.name = e.target.value; changed(); },
  });
  const widthInput = (row, max) => h("input", {
    class: "mono expr-width",
    type: "number",
    min: 1,
    max,
    value: String(row.width),
    "aria-label": t("exprWidth"),
    title: t("exprWidth"),
    oninput: (e) => { row.width = e.target.value === "" ? 0 : Number(e.target.value); changed(); },
  });
  const exprInput = (row) => h("input", {
    class: "mono expr-expr",
    value: row.expr,
    placeholder: t("fn_expr"),
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": `${row.name || t("exprName")} =`,
    oninput: (e) => { row.expr = e.target.value; changed(); },
  });
  const remove = (list, row) => h("button", {
    type: "button",
    class: "ghost expr-remove",
    title: t("removeRow"),
    "aria-label": t("removeRow"),
    onclick: () => { list.splice(list.indexOf(row), 1); rebuild(); },
  }, "×");
  const section = (title, list, row, add, blankRow) => h("div", { class: "expr-section" },
    h("div", { class: "io-title" }, title),
    list.map((r) => h("div", { class: "expr-row" }, row(r), remove(list, r))),
    h("button", { type: "button", class: "ghost", onclick: () => { list.push(blankRow()); rebuild(); } }, add));
  const fresh = (prefix, list) => {
    let k = list.length;
    while (list.some((r) => r.name === `${prefix}${k}`)) k += 1;
    return `${prefix}${k}`;
  };

  const applyJson = () => {
    try {
      const spec = JSON.parse(json.value);
      const editor = exprEditorFrom(spec);
      const st = exprStatus(editor);
      if (!st.ok) throw new Error(st.message);
      state.expr = editor;
      rebuild();
    } catch (error) {
      showEditorError(error);
    }
  };

  const understanding = h("section", { class: "understand" },
    h("h3", { class: "hero-title" }, t("readbackTitle")),
    readback,
    status);

  const view = h("div", { class: "expr" },
    understanding,
    h("div", { class: "advanced" },
      section(t("exprInputs"), x.inputs, (r) => [nameInput(r), widthInput(r, 20), h("span", { class: "muted small" }, t("exprWidth"))],
        t("addInput"), () => ({ name: fresh("in", x.inputs), width: 1 })),
      section(t("exprStates"), x.states, (r) => [nameInput(r), widthInput(r, 20), h("span", { class: "muted small" }, t("nextIs")), exprInput(r)],
        t("addState"), () => ({ name: fresh("s", x.states), width: 1, expr: "" })),
      section(t("exprLets"), x.lets, (r) => [nameInput(r), h("span", { class: "muted" }, "="), exprInput(r)],
        t("addLet"), () => ({ name: fresh("t", x.lets), expr: "" })),
      section(t("exprOutputs"), x.outputs, (r) => [nameInput(r), widthInput(r, 32), h("span", { class: "muted" }, "="), exprInput(r)],
        t("addOutput"), () => ({ name: fresh("out", x.outputs), width: 1, expr: "" })),
      section(t("examplesTitle"), x.examples, (r) => {
        const mark = h("span", { class: "verdict-mark muted" }, "·");
        verdicts.set(r, mark);
        return [mark, h("input", {
          class: "mono expr-expr",
          value: r.text,
          placeholder: t("examplePlaceholder"),
          spellcheck: "false",
          autocomplete: "off",
          "aria-label": t("examplesTitle"),
          oninput: (e) => { r.text = e.target.value; changed(); },
        }), h("div", { class: "example-why small disagree" })];
      }, t("addExample"), () => ({ text: "" })),
      h("p", { class: "note" }, t("exprSemantics")),
      h("details", { class: "block" },
        h("summary", {}, t("exprJson")),
        h("p", { class: "note" }, t("exprJsonNote")),
        json,
        h("div", { class: "toolbar" }, h("button", { type: "button", onclick: applyJson }, t("applyJson"))))));
  refresh();
  return view;
}

// Can this browser talk to that provider at all? Some endpoints refuse a request that comes
// straight from a page (CORS), and the honest answer then is "use the copied prompt". One
// request with whatever key is in the box: a refusal with a message means the road is open.
function reachRow(d) {
  const status = h("span", { class: "small muted" }, t("reachUnknown"));
  const button = h("button", { type: "button", class: "ghost" }, t("reachTest"));
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.className = "small muted";
    status.textContent = t("reachTesting");
    try {
      const { url, init } = modelRequest({
        provider: d.provider,
        baseUrl: d.baseUrl.trim(),
        model: d.model.trim() || "probe",
        key: secret.key.trim() || "probe-key",
        messages: [{ role: "user", content: "hi" }],
      });
      const answer = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
      status.className = "small agree";
      status.textContent = t("reachOk", answer.status);
    } catch (error) {
      status.className = "small question";
      status.textContent = t("reachBlocked", error.message);
    }
    button.disabled = false;
  });
  return h("div", { class: "toolbar" }, button, status);
}

function byokPanel(d, rebuild) {
  const p = PROVIDERS[d.provider];
  const status = h("div", { class: "small ask-status", role: "status" });
  const ask = h("button", { type: "button", class: "primary big", disabled: secret.asking || undefined }, secret.asking ? t("asking") : t("askModel"));
  ask.addEventListener("click", async () => {
    if (!d.sentence.trim()) return showEditorError(new Error(t("describeEmpty")));
    if (!secret.key.trim() && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(d.baseUrl.trim())) {
      status.className = "small ask-status question";
      status.textContent = t("needKey");
      const settings = $("#editor .hero details.quiet");
      if (settings) settings.open = true;
      return;
    }
    secret.asking = true;
    ask.disabled = true;
    ask.textContent = t("asking");
    status.className = "small ask-status muted";
    try {
      const result = await askModel({
        provider: d.provider,
        baseUrl: d.baseUrl.trim(),
        model: d.model.trim(),
        key: secret.key,
        sentence: d.sentence,
        onAttempt: (n) => { status.textContent = t("askingAttempt", n); },
      });
      secret.asking = false;
      if (result.question) {
        ask.disabled = false;
        ask.textContent = t("askModel");
        status.className = "small ask-status question";
        status.textContent = `? ${t("modelAsks")} ${result.question}`;
        return;
      }
      state.expr = exprEditorFrom(result.spec);
      state.compile.names.expr = ""; // a new program is not the example that was loaded before
      rebuild();
      renderCompileBar();
      const note = $("#editor .ask-status");
      if (note) { note.className = "small ask-status agree"; note.textContent = `✓ ${t("askedOk", result.attempts)}`; }
    } catch (error) {
      secret.asking = false;
      ask.disabled = false;
      ask.textContent = t("askModel");
      status.className = "small ask-status disagree";
      status.textContent = `✗ ${error.message}`;
    }
  });
  const field = (label, input) => h("label", { class: "field" }, h("span", {}, label), input);
  const settings = h("div", { class: "byok" },
    h("div", { class: "fields" },
      field(t("provider"), h("select", {
        // The address, model and key fields show the chosen provider's defaults, so they have to
        // be drawn again - otherwise "a model on this computer" still showed Anthropic's.
        onchange: (e) => { d.provider = e.target.value; d.baseUrl = ""; d.model = ""; save(); renderEditor(); renderSettings(); renderHeader(); if (state.view === "decide") renderDecide($("#decide"), t); },
      }, Object.keys(PROVIDERS).map((k) => h("option", { value: k, selected: d.provider === k }, PROVIDERS[k].label[state.lang] ?? PROVIDERS[k].label.en)))),
      field(t("modelName"), h("input", { value: d.model, placeholder: p.model || t("modelRequired"), spellcheck: "false", autocomplete: "off", oninput: (e) => { d.model = e.target.value; save(); } })),
      field(t("apiAddress"), h("input", { value: d.baseUrl, placeholder: p.baseUrl, spellcheck: "false", autocomplete: "off", oninput: (e) => { d.baseUrl = e.target.value; save(); } }))),
    h("div", { class: "fields" },
      field(t("apiKey"), h("input", {
        type: "password",
        value: secret.key,
        autocomplete: "off",
        spellcheck: "false",
        placeholder: t("apiKeyPlaceholder"),
        oninput: (e) => { secret.key = e.target.value; keepKey(); },
      }))),
    h("label", { class: "check small" },
      h("input", { type: "checkbox", checked: secret.remember || undefined, onchange: (e) => { secret.remember = e.target.checked; keepKey(); } }),
      t("rememberKey")),
    reachRow(d),
    h("p", { class: "note" }, t("byokNote")));
  return { ask, status, settings };
}

let stopPainting = null;

function gridEditor() {
  const g = state.grid;
  const counts = [0, 0, 0, 0];
  for (const row of g.map) for (const v of row) counts[v] += 1;
  const countEls = counts.map((n) => h("span", { class: "count mono" }, n));
  const swatches = g.labels.map((label, k) => h("div", {
    class: `swatch${g.brush === k ? " active" : ""}`,
    onclick: () => selectBrush(k),
  },
  h("span", { class: `chip c${k}` }),
  h("input", {
    value: label,
    maxlength: 24,
    "aria-label": t("choiceName", k),
    oninput: (e) => { g.labels[k] = e.target.value; edited(); },
  }),
  countEls[k]));
  function selectBrush(k) {
    g.brush = k;
    swatches.forEach((el, i) => el.classList.toggle("active", i === k));
    save();
  }

  const board = h("div", { class: "grid16" }, h("div", { class: "axis corner" }, "X↓ Y→"));
  for (let y = 0; y < 16; y++) board.append(h("div", { class: "axis" }, y));
  for (let x = 0; x < 16; x++) {
    board.append(h("div", { class: "axis" }, x));
    for (let y = 0; y < 16; y++) board.append(h("div", { class: `cell c${g.map[x][y]}`, title: `X=${x}, Y=${y}`, "data-x": x, "data-y": y }));
  }
  let painting = false;
  let dirty = false;
  const paint = (cell) => {
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const old = g.map[x][y];
    if (old === g.brush) return;
    g.map[x][y] = g.brush;
    cell.className = `cell c${g.brush}`;
    counts[old] -= 1;
    counts[g.brush] += 1;
    countEls[old].textContent = counts[old];
    countEls[g.brush].textContent = counts[g.brush];
    dirty = true;
  };
  board.addEventListener("pointerdown", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    e.preventDefault();
    painting = true;
    paint(cell);
  });
  board.addEventListener("pointermove", (e) => {
    if (!painting) return;
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".cell");
    if (cell && board.contains(cell)) paint(cell);
  });
  stopPainting = () => {
    painting = false;
    if (dirty) {
      dirty = false;
      edited();
    }
  };

  return h("div", {},
    h("div", { class: "palette" }, swatches),
    board,
    expressionRow("grid", t("fn_grid"), (fn) => {
      const { table } = gridTable({ fn });
      for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) g.map[x][y] = table.ys[x + y * 16];
    }),
    h("div", { class: "toolbar" }, h("button", {
      type: "button",
      class: "ghost",
      onclick: () => {
        for (const row of g.map) row.fill(g.brush);
        edited();
        renderEditor();
      },
    }, t("fillAll"))));
}

function reshaper(editor) {
  return (patch) => {
    editor.ys = resizeRows(editor, { ...editor, ...patch });
    Object.assign(editor, patch);
    edited();
    renderEditor();
  };
}

function tableEditor() {
  const tb = state.table;
  const reshape = reshaper(tb);
  const rows = 2 ** tb.nIn;
  const editable = rows <= EDITABLE_ROWS;
  const body = [];
  for (let x = 0; x < Math.min(rows, EDITABLE_ROWS); x++) {
    const valueCell = h("td", { class: "mono muted" }, tb.ys[x]);
    const bits = [];
    for (let k = tb.nOut - 1; k >= 0; k--) {
      bits.push(h("td", {}, bitButton(() => Math.floor(tb.ys[x] / 2 ** k) % 2, editable && (() => {
        tb.ys[x] ^= 1 << k;
        valueCell.textContent = tb.ys[x];
        edited();
      }), `y${k}`)));
    }
    body.push(h("tr", {}, h("td", { class: "mono" }, x.toString(2).padStart(tb.nIn, "0"), h("span", { class: "muted" }, ` = ${x}`)), bits, valueCell));
  }
  const head = h("tr", {}, h("th", {}, t("colInput")), Array.from({ length: tb.nOut }, (_, i) => h("th", {}, `y${tb.nOut - 1 - i}`)), h("th", {}, "y"));
  return h("div", {},
    h("div", { class: "shape" },
      shapeInput(t("inputBits"), tb.nIn, LIMITS.table.nIn, (nIn) => reshape({ nIn })),
      shapeInput(t("outputBits"), tb.nOut, LIMITS.table.nOut, (nOut) => reshape({ nOut }))),
    expressionRow("table", t("fn_table"), (fn) => { tb.ys = [...combinationalTable({ nIn: tb.nIn, nOut: tb.nOut, fn }).ys]; }),
    editable ? null : h("p", { class: "note" }, t("previewRows", num(EDITABLE_ROWS), num(rows))),
    h("div", { class: "rows" }, h("table", {}, h("thead", {}, head), h("tbody", {}, body))));
}

function fsmEditor() {
  const f = state.fsm;
  const reshape = reshaper(f);
  const width = 2 ** f.nIn;
  const rows = 2 ** (f.nIn + f.nState);
  const editable = rows <= EDITABLE_ROWS;
  const M = 2 ** f.nOut;
  const graphBox = h("div", {}, stateDiagram(f));
  const refresh = () => { edited(); fill(graphBox, stateDiagram(f)); };
  const body = [];
  for (let r = 0; r < Math.min(rows, EDITABLE_ROWS); r++) {
    const x = r % width;
    const s = Math.floor(r / width);
    const cells = [];
    if (x === 0) cells.push(h("td", { class: "state mono", rowspan: Math.min(width, EDITABLE_ROWS - r) }, `s${s}`));
    cells.push(h("td", { class: "mono" }, x.toString(2).padStart(f.nIn, "0")));
    for (let k = f.nOut - 1; k >= 0; k--) {
      cells.push(h("td", {}, bitButton(() => Math.floor(f.ys[r] / 2 ** k) % 2, editable && (() => {
        const y = f.ys[r] % M;
        f.ys[r] = f.ys[r] - y + (y ^ (1 << k));
        refresh();
      }), `y${k}`)));
    }
    const next = Math.floor(f.ys[r] / M);
    cells.push(h("td", {}, h("select", {
      disabled: !editable,
      "aria-label": `${t("colNext")} s${s} x${x}`,
      onchange: (e) => {
        f.ys[r] = (f.ys[r] % M) + Number(e.target.value) * M;
        refresh();
      },
    }, Array.from({ length: 2 ** f.nState }, (_, n) => h("option", { value: n, selected: n === next }, `s${n}`)))));
    body.push(h("tr", {}, cells));
  }
  const head = h("tr", {}, h("th", {}, t("colState")), h("th", {}, t("colInput")), Array.from({ length: f.nOut }, (_, i) => h("th", {}, `y${f.nOut - 1 - i}`)), h("th", {}, t("colNext")));
  return h("div", {},
    h("div", { class: "shape" },
      shapeInput(t("inputBits"), f.nIn, LIMITS.fsm.nIn, (nIn) => reshape({ nIn })),
      shapeInput(t("stateBits"), f.nState, LIMITS.fsm.nState, (nState) => reshape({ nState })),
      shapeInput(t("outputBits"), f.nOut, LIMITS.fsm.nOut, (nOut) => reshape({ nOut }))),
    expressionRow("fsm", t("fn_fsm"), (fn) => { f.ys = [...fsmTable({ nIn: f.nIn, nState: f.nState, nOut: f.nOut, fn }).ys]; }),
    editable ? null : h("p", { class: "note" }, t("previewRows", num(EDITABLE_ROWS), num(rows))),
    h("div", { class: "fsm-layout" },
      h("div", { class: "rows" }, h("table", {}, h("thead", {}, head), h("tbody", {}, body))),
      graphBox));
}

function stateDiagram(table) {
  const S = 2 ** table.nState;
  if (S > 8 || table.nIn > 3) return h("p", { class: "note" }, t("graphTooBig"));
  const graph = stateGraph(table);
  const radius = S === 1 ? 0 : 50 + 13 * S;
  const size = 2 * radius + 210;
  const c = size / 2;
  const at = (i) => [c + radius * Math.sin((2 * Math.PI * i) / S), c - radius * Math.cos((2 * Math.PI * i) / S)];
  const r = 18;
  const parts = [svg("defs", {}, svg("marker", { id: "state-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" }, svg("path", { d: "M0,0 L10,5 L0,10 z", class: "arrowhead" })))];
  const f1 = (n) => n.toFixed(1);
  for (const edge of graph.edges) {
    const label = edge.cases.map((k) => `${k.x}/${k.y}`).join(" ");
    const [x1, y1] = at(edge.from);
    if (edge.from === edge.to) {
      const angle = S === 1 ? -Math.PI / 2 : Math.atan2(y1 - c, x1 - c);
      const point = (d, spread) => [x1 + d * Math.cos(angle + spread), y1 + d * Math.sin(angle + spread)].map(f1).join(",");
      parts.push(svg("path", { class: "edge", d: `M${point(r, -0.45)} C${point(62, -0.55)} ${point(62, 0.55)} ${point(r + 2, 0.45)}`, "marker-end": "url(#state-arrow)" }));
      const [lx, ly] = [x1 + 64 * Math.cos(angle), y1 + 64 * Math.sin(angle)];
      parts.push(svg("text", { class: "edge-label", x: f1(lx), y: f1(ly + 4), "text-anchor": Math.cos(angle) > 0.3 ? "start" : Math.cos(angle) < -0.3 ? "end" : "middle" }, label));
    } else {
      const [x2, y2] = at(edge.to);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
      const [nx, ny] = [-uy, ux];
      const bend = 20;
      const [sx, sy, ex, ey] = [x1 + ux * r, y1 + uy * r, x2 - ux * (r + 2), y2 - uy * (r + 2)];
      const [mx, my] = [(sx + ex) / 2 + nx * bend, (sy + ey) / 2 + ny * bend];
      parts.push(svg("path", { class: "edge", d: `M${f1(sx)},${f1(sy)} Q${f1(mx)},${f1(my)} ${f1(ex)},${f1(ey)}`, "marker-end": "url(#state-arrow)" }));
      parts.push(svg("text", { class: "edge-label", x: f1((sx + ex) / 2 + nx * (bend + 6)), y: f1((sy + ey) / 2 + ny * (bend + 6) + 3), "text-anchor": "middle" }, label));
    }
  }
  for (let s = 0; s < S; s++) {
    const [x, y] = at(s);
    const cls = `st${s === 0 ? " start" : ""}${graph.reachable.has(s) ? "" : " unreachable"}`;
    parts.push(svg("circle", { class: cls, cx: f1(x), cy: f1(y), r }), svg("text", { x: f1(x), y: f1(y + 4), "text-anchor": "middle" }, `s${s}`));
  }
  return h("div", {},
    svg("svg", { class: "stategraph", viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: "img" }, parts),
    h("p", { class: "note" }, t("graphLegend")));
}

// ---- step 2: compile and prove ------------------------------------------------

function renderCompileBar() {
  const c = state.compile;
  const field = (key, label, placeholder, extra = {}) => h("label", { class: "field" },
    h("span", {}, label),
    h("input", { value: c[key], placeholder, spellcheck: "false", autocomplete: "off", oninput: (e) => { c[key] = e.target.value; save(); }, ...extra }));
  fill($("#compile-bar"),
    h("div", { class: "fields" },
      h("label", { class: "field" },
        h("span", {}, t("name")),
        h("input", { value: c.names[state.kind], placeholder: defaultName(), spellcheck: "false", autocomplete: "off", oninput: (e) => { c.names[state.kind] = e.target.value; save(); } })),
      field("steps", t("steps"), t("auto"), { inputmode: "numeric" }),
      field("seed", t("seed"), t("fromTable")),
      h("label", { class: "field" },
        h("span", {}, t("objective")),
        h("select", { onchange: (e) => { c.objective = e.target.value; save(); } },
          ["gates", "cost"].map((o) => h("option", { value: o, selected: c.objective === o }, t(`objective_${o}`)))))),
    h("div", { class: "actions" },
      run.worker
        ? h("button", { type: "button", onclick: cancelCompile }, t("cancel"))
        : h("button", { type: "button", class: "primary", onclick: startCompile }, `${t("compile")} · ${t(`kind_${state.kind}`)}`)),
    run.worker ? progressView() : null,
    run.error ? h("div", { class: "error", role: "alert" }, run.error) : null,
    run.wide && !run.worker ? widePanel() : null);
}

// The program is wider than one proof can hold. It can still be built, as blocks that each
// get their own proof; how they are joined is the person's decision, not the compiler's,
// because it changes what gets deployed: one circuit that refers to the blocks, or the
// blocks alone with an order to run them in.
function widePanel() {
  const choice = (compose, title, hint) => h("button", { type: "button", class: "wide-choice", onclick: () => startCompile({ compose }) },
    h("span", { class: "wide-choice-title" }, title),
    h("span", { class: "wide-choice-hint muted small" }, hint));
  return h("div", { class: "wide-panel", role: "status" },
    h("div", { class: "wide-title" }, t("wideTitle", run.wide.bits)),
    h("p", { class: "muted small" }, t("wideBody")),
    h("div", { class: "wide-choices" },
      choice("linked", t("wideLinked"), t("wideLinkedHint")),
      choice("replay", t("wideReplay"), t("wideReplayHint"))));
}

function progressView() {
  return h("div", { class: "progress", id: "progress" },
    h("div", { class: "track" }, h("div", { class: "fill" })),
    h("div", { class: "label" }, h("span", { class: "phase" }), h("span", { class: "elapsed mono" })));
}

function updateProgress() {
  const box = $("#progress");
  const p = run.progress;
  if (!box || !p) return;
  const fraction = p.steps ? p.step / p.steps : 0;
  const done = p.phase === "synthesis" ? 0.03 : p.phase === "annealing" || p.phase === "block" ? 0.05 + 0.9 * fraction : 0.97;
  box.querySelector(".fill").style.width = `${(done * 100).toFixed(1)}%`;
  box.querySelector(".phase").textContent = t(`phase_${p.phase}`) + (p.phase === "annealing" ? ` ${num(p.step)} / ${num(p.steps)}` : p.phase === "block" ? ` ${p.step + 1} / ${p.steps}` : "");
  box.querySelector(".elapsed").textContent = `${((performance.now() - run.started) / 1000).toFixed(1)} s`;
}

function cancelCompile() {
  run.worker?.terminate();
  run.worker = null;
  run.progress = null;
  renderCompileBar();
}

function startCompile(options = {}) {
  run.error = null;
  run.wide = null;
  const compose = options.compose === "linked" || options.compose === "replay" ? options.compose : undefined;
  try {
    const c = state.compile;
    const name = c.names[state.kind].trim() || defaultName();
    if (!NAME_RE.test(name)) throw new Error(t("badName"));
    const stepsText = c.steps.trim();
    if (stepsText && (!/^[1-9][0-9]*$/.test(stepsText) || Number(stepsText) > 1e9)) throw new Error(t("badSteps"));
    let seed;
    if (c.seed.trim()) {
      try {
        seed = parseSeed(c.seed);
      } catch {
        throw new Error(t("badSeed"));
      }
    }
    const kind = state.kind;
    let labels;
    if (kind === "grid") {
      labels = state.grid.labels.map((label) => label.trim());
      const problem = labelProblem(labels);
      if (problem) throw new Error(t(problem));
    }
    const spec = specFor(kind, state[kind]);
    const job = { kind, spec, labels, name, steps: stepsText ? Number(stepsText) : undefined, seed, objective: c.objective, sentence: state.describe.sentence, lang: state.lang, compose };

    run.worker?.terminate();
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    run.worker = worker;
    run.started = performance.now();
    run.progress = { phase: "synthesis", step: 0, steps: 0 };
    worker.addEventListener("message", ({ data }) => {
      if (worker !== run.worker) return;
      if (data.type === "progress") {
        run.progress = data;
        updateProgress();
        return;
      }
      worker.terminate();
      run.worker = null;
      run.progress = null;
      if (data.type === "error") run.error = data.message;
      else if (data.type === "wide") run.wide = { bits: data.bits, message: data.message };
      else accept({ ...data, kind, spec, labels, name });
      renderCompileBar();
      renderProof();
      renderCircuit();
      renderTapeout();
      renderHeader();
      renderFlow();
    });
    worker.addEventListener("error", (event) => {
      if (worker !== run.worker) return;
      worker.terminate();
      run.worker = null;
      run.error = event.message || t("workerFailed");
      renderCompileBar();
      renderFlow();
    });
    worker.postMessage(job);
  } catch (error) {
    run.error = error.message;
  }
  renderCompileBar();
  updateProgress();
}

function remember(result) {
  if (result.kind !== "expr" || result.composed) return;
  const entry = historyEntry({ name: result.name, sentence: state.describe.sentence, spec: result.spec, certificate: result.certificate });
  state.history = rememberCircuit(state.history, entry);
  state.last = entry;
  save();
}

function accept(result) {
  if (result.composed) {
    // Blocks, not one circuit: the proof view lists them; the single-circuit views stay hidden.
    run.result = { ...result, circuit: null, stale: false };
    run.sim = null;
    run.plan = null;
    return;
  }
  // Everything past this point works from the decoded netlist bytes, the thing that would be taped out.
  const circuit = decodeCircuit(hexToBytes(result.netlist.netlistHex), result.netlist.nIn, result.netlist.nOut);
  if (circuit.nNand !== result.netlist.nand || circuit.nLatch !== result.netlist.latch) {
    run.error = "netlist bytes do not match the reported gate counts";
    return;
  }
  run.result = { ...result, circuit, stale: false };
  remember(run.result);
  run.sim = { inputs: new Array(result.netlist.nIn).fill(0), state: new Array(result.netlist.nState).fill(0), trace: [] };
  run.plan = null;
}

function renderProof() {
  const root = $("#proof");
  const r = run.result;
  if (!r) {
    fill(root, h("p", { class: "placeholder" }, t("proofPlaceholder")));
    return;
  }
  if (r.composed) {
    renderComposedProof(root, r);
    return;
  }
  const cert = r.certificate;
  const c = cert.circuit;
  const v = cert.verification;
  const syn = cert.synthesis;
  const ratio = syn.nandAfterSynthesis ? syn.nandAfterAnnealing / syn.nandAfterSynthesis : 1;
  const tiles = [["NAND", c.nand], ["LATCH", c.latch], [t("depth"), c.depth], [t("podCost"), c.podCost], [t("bytes"), c.netlistBytes]];
  const command = cliCommand(r.kind, { name: r.name, labels: r.labels, seed: cert.reproduce.seed, steps: cert.reproduce.steps, objective: cert.reproduce.objective });

  fill(root,
    r.stale ? h("div", { class: "stale" }, t("stale")) : null,
    h("div", { class: "verdict" },
      h("div", { class: "seal", "aria-hidden": "true" }, "✓"),
      h("div", {},
        h("div", { class: "rows-proven mono" }, `${num(v.rowsChecked - v.wrong)} / ${num(v.rowsChecked)}`),
        h("div", {}, t(r.kind === "fsm" ? "provenFsm" : "provenRows")),
        h("div", { class: "muted small" }, t("methods", v.methods.join(" + "))))),
    h("div", { class: "tiles" }, tiles.map(([label, value]) => h("div", { class: "tile" },
      h("div", { class: "tile-value mono" }, num(value)),
      h("div", { class: "tile-label" }, label)))),
    h("div", { class: "block" },
      h("div", { class: "muted small" }, t("shrink", num(syn.nandAfterSynthesis), num(syn.nandAfterAnnealing))),
      h("div", { class: "meter" }, h("div", { class: "fill", style: { width: `${(ratio * 100).toFixed(1)}%` } }))),
    h("div", { class: "block" }, facts(r)),
    h("details", { class: "block" },
      h("summary", {}, t("reproduce")),
      h("dl", { class: "facts" },
        pair(t("seed"), h("span", { class: "mono" }, cert.reproduce.seed)),
        pair(t("steps"), h("span", { class: "mono" }, num(cert.reproduce.steps))),
        pair(t("tableHash"), h("span", { class: "mono small" }, cert.table.sha256)),
        pair(t("netlistHash"), h("span", { class: "mono small" }, c.netlistSha256)),
        pair(t("variableOrder"), h("span", { class: "mono small" },
          syn.variableOrder.map((v) => (v < cert.table.nIn ? `x${v}` : `s${v - cert.table.nIn}`)).join(" "),
          syn.sifted ? ` · ${t("sifted")}` : ""))),
      h("p", { class: "note" }, t("reproduceNote")),
      h("pre", { class: "cmd" }, command),
      h("div", { class: "downloads" },
        copyButton(t("copy"), command),
        h("button", { type: "button", class: "ghost", onclick: () => download(specFileName(r.kind, r.name), specText(r.kind, r.spec)) }, `↓ ${t("downloadSpec")}`))),
    h("div", { class: "downloads" }, Object.entries(r.files).map(([file, text]) => h("button", {
      type: "button",
      onclick: () => download(`${r.name}.${file}`, text),
    }, `↓ ${file}`))));
}

// Several proofs instead of one: each block on every row of its own table, the top circuit
// with nothing in it but latches and REFs, and the whole cross-checked against the program.
function renderComposedProof(root, r) {
  const cert = r.certificate;
  const v = cert.verification;
  const blocks = cert.blocks;
  const tiles = [[t("composedBlocks"), blocks.length], ["REF", cert.top.refs], ["LATCH", cert.top.latch], ["NAND", v.nandTotal], [t("bits"), cert.program.bits]];
  fill(root,
    r.stale ? h("div", { class: "stale" }, t("stale")) : null,
    h("div", { class: "verdict" },
      h("div", { class: "seal", "aria-hidden": "true" }, "✓"),
      h("div", {},
        h("div", { class: "rows-proven mono" }, `${blocks.length} × ${t("composedEvery")}`),
        h("div", {}, t("composedProven", blocks.length)),
        h("div", { class: "muted small" }, t(r.compose === "linked" ? "deliveryLinked" : "deliveryReplay")))),
    h("div", { class: "tiles" }, tiles.map(([label, value]) => h("div", { class: "tile" },
      h("div", { class: "tile-value mono" }, num(value)),
      h("div", { class: "tile-label" }, label)))),
    h("div", { class: "block" },
      h("table", { class: "blocks" },
        h("thead", {}, h("tr", {}, h("th", {}, t("composedComputes")), h("th", {}, t("composedReads")), h("th", {}, "NAND"), h("th", {}, t("composedRows")))),
        h("tbody", {}, blocks.map((b) => h("tr", {},
          h("td", {}, b.computes.map((u) => u.name).join(", ")),
          h("td", { class: "mono small" }, `${b.nIn} → ${b.nOut}`),
          h("td", { class: "mono" }, num(b.nand)),
          h("td", { class: "mono" }, `${num(b.rowsChecked - b.wrong)} / ${num(b.rowsChecked)}`)))))),
    h("p", { class: "note" }, t("composedTop", cert.top.latch, cert.top.refs)),
    h("p", { class: "note" }, t("composedEndToEnd", num(v.endToEnd.rows), v.endToEnd.exhaustive)),
    cert.inlined.length ? h("p", { class: "note muted small" }, t("composedInlined", cert.inlined.join(", "))) : null,
    h("p", { class: "note muted small" }, t("composedNoSim")),
    h("div", { class: "downloads" }, Object.entries(r.files).map(([file, text]) => h("button", {
      type: "button",
      onclick: () => download(`${r.name}.${file}`, text),
    }, `↓ ${file}`))));
}

function facts(r) {
  const cert = r.certificate;
  if (r.kind === "grid") {
    const choices = Object.entries(cert.grid.choices);
    return h("div", {},
      h("div", { class: "choice-chips" }, choices.map(([label, count], k) => h("span", { class: `choice${count ? "" : " never"}` },
        h("span", { class: `chip c${k}` }), label, h("span", { class: "muted mono" }, num(count))))),
      h("div", { class: "small" }, cert.grid.neverChosen.length ? t("neverChosen", cert.grid.neverChosen.join(", ")) : t("everyChoiceUsed")));
  }
  if (r.kind === "fsm") {
    const m = cert.stateMachine;
    return h("div", { class: "small" }, t("reachable", m.reachableFromStart, m.reachableFromStart + m.unreachableStates));
  }
  const parts = [];
  const starts = cert.synthesis.startsConsidered;
  if (starts) {
    parts.push(h("div", { class: "io-title" }, t("startsTitle")),
      h("dl", { class: "facts" }, starts.map((s) => pair(t(`frontEnd_${s.frontEnd}`),
        h("span", {}, h("span", { class: "mono" }, `${num(s.nand)} NAND`),
          s.frontEnd === cert.synthesis.frontEnd ? h("strong", {}, ` · ${t("startChosen")}`) : null,
          s.exact ? null : h("span", { class: "muted" }, ` · ${t("startInexact")}`))))));
  }
  if (r.kind === "expr") {
    const e = cert.expression;
    if (e.examplesHold) parts.push(h("div", { class: "agree small" }, `✓ ${t("examplesHoldProof", e.examplesHold)}`));
    parts.push(h("dl", { class: "facts" },
      [...e.inputs.map((f) => pair(`${t("tryInputs")} ${f.name}`, h("span", { class: "mono small" }, f.at))),
        ...e.outputs.map((f) => pair(`${t("tryOutputs")} ${f.name}`, h("span", { class: "mono small" }, f.at)))]));
  } else {
    parts.push(h("div", { class: "small" }, t("tableShape", cert.table.nIn, cert.table.nOut)));
  }
  return h("div", {}, parts);
}

// ---- step 3: try it -----------------------------------------------------------

function renderCircuit() {
  const r = run.result;
  $("#circuit-section").hidden = !r || r.composed;
  if (!r || r.composed) return;
  const { nIn, nState, nOut } = r.netlist;
  const sim = run.sim;
  const step = simulate(r.circuit, sim.inputs, Uint8Array.from(sim.state));
  const x = valueOf(sim.inputs);
  const s = valueOf(sim.state);
  const packed = r.table.ys[x + s * 2 ** nIn];
  const want = { y: packed % 2 ** nOut, next: Math.floor(packed / 2 ** nOut) };
  const got = { y: valueOf([...step.outputs]), next: valueOf([...step.newState]) };
  const agrees = got.y === want.y && (nState === 0 || got.next === want.next);
  const again = () => renderCircuit();

  const panel = [];
  if (r.kind === "expr") {
    const { inputs, outputs } = r.certificate.expression;
    const values = unpackFields(inputs, x);
    panel.push(h("div", {},
      h("div", { class: "io-title" }, t("tryInputs")),
      h("div", { class: "named-sliders" }, inputs.map((f, i) => {
        const max = 2 ** f.width - 1;
        const set = (v) => {
          if (!Number.isInteger(v) || v < 0 || v > max) return;
          values[i] = v;
          sim.inputs = bitsOf(packFields(inputs, values), nIn);
          again();
        };
        return h("label", { class: "named-slider" },
          h("span", { class: "mono", title: `${f.width} ${t("exprWidth")} · ${f.at}` }, f.name),
          h("input", { type: "range", min: 0, max, value: String(values[i]), oninput: (e) => set(Number(e.target.value)) }),
          h("input", { type: "number", class: "mono", min: 0, max, value: String(values[i]), "aria-label": f.name, onchange: (e) => set(Number(e.target.value)) }));
      }))));
    const shown = (fields, packed) => h("dl", { class: "facts" }, unpackFields(fields, packed).map((v, i) => pair(fields[i].name,
      h("span", {}, h("strong", { class: "mono" }, v), h("span", { class: "muted small mono" }, `  ${v.toString(2).padStart(fields[i].width, "0")}`)))));
    const stateFields = r.certificate.expression.state ?? [];
    if (nState) {
      panel.push(h("div", {}, h("div", { class: "io-title" }, t("tryState")), shown(stateFields, s)));
      panel.push(h("div", { class: "actions" },
        h("button", {
          type: "button",
          class: "primary",
          onclick: () => {
            sim.trace.unshift({ s, x, y: got.y, next: got.next });
            sim.trace.length = Math.min(sim.trace.length, 8);
            sim.state = [...step.newState];
            again();
          },
        }, t("tick")),
        h("button", { type: "button", onclick: () => { sim.state.fill(0); sim.trace = []; again(); } }, t("reset"))));
    }
    panel.push(h("div", {}, h("div", { class: "io-title" }, t("tryOutputs")), shown(outputs, got.y)));
    if (nState) panel.push(h("div", {}, h("div", { class: "io-title" }, t("tryNextState")), shown(stateFields, got.next)));
  } else if (r.kind === "grid") {
    const X = x % 16;
    const Y = Math.floor(x / 16);
    const slider = (label, value, set) => h("label", { class: "slider" },
      h("span", {}, label),
      h("input", { type: "range", min: 0, max: 15, value: String(value), oninput: (e) => { set(Number(e.target.value)); again(); } }),
      h("span", {}, value));
    panel.push(h("div", {},
      h("div", { class: "io-title" }, t("tryInputs")),
      slider("X", X, (v) => { sim.inputs = [...bitsOf(v, 4), ...bitsOf(Y, 4)]; }),
      slider("Y", Y, (v) => { sim.inputs = [...bitsOf(X, 4), ...bitsOf(v, 4)]; })));
    panel.push(h("div", {},
      h("div", { class: "io-title" }, t("tryOutputs")),
      h("span", { class: "big-choice" }, h("span", { class: `chip c${got.y}` }), r.labels[got.y])));
  } else {
    panel.push(bitsBlock(t("tryInputs"), sim.inputs, "x", (i) => { sim.inputs[i] ^= 1; again(); }));
    if (nState) {
      panel.push(bitsBlock(t("tryState"), sim.state, "s"));
      panel.push(h("div", { class: "actions" },
        h("button", {
          type: "button",
          class: "primary",
          onclick: () => {
            sim.trace.unshift({ s, x, y: got.y, next: got.next });
            sim.trace.length = Math.min(sim.trace.length, 8);
            sim.state = [...step.newState];
            again();
          },
        }, t("tick")),
        h("button", { type: "button", onclick: () => { sim.state.fill(0); sim.trace = []; again(); } }, t("reset"))));
    }
    panel.push(bitsBlock(t("tryOutputs"), [...step.outputs], "y"));
  }
  panel.push(h("div", { class: agrees ? "agree" : "disagree" }, agrees ? `✓ ${t("agrees")}` : `✗ ${t("disagrees")}`));
  if (nState && sim.trace.length) {
    panel.push(h("div", {},
      h("div", { class: "io-title" }, t("traceTitle")),
      h("div", { class: "rows" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, t("colState")), h("th", {}, "x"), h("th", {}, "y"), h("th", {}, t("colNext")))),
        h("tbody", {}, sim.trace.map((row) => h("tr", {}, [row.s, row.x, row.y, row.next].map((v, i) => h("td", { class: "mono" }, i === 0 || i === 3 ? `s${v}` : v)))))))));
  }

  const layout = diagramLayout(r.circuit);
  fill($("#circuit"), h("div", { class: "try" },
    h("div", { class: "panel" }, panel),
    h("div", {},
      layout ? drawCircuit(layout, step.signals) : h("p", { class: "placeholder" }, t("tooBigToDraw", num(r.circuit.elements.length))),
      layout ? h("p", { class: "note" }, t("diagramNote")) : null)));
}

function bitsBlock(title, bits, prefix, toggle) {
  return h("div", {},
    h("div", { class: "io-title" }, h("span", {}, title), h("span", { class: "mono" }, `= ${valueOf(bits)}`)),
    h("div", { class: "bits" }, bits.map((_, j) => {
      const i = bits.length - 1 - j;
      return h("span", { class: "bitcell" }, bitButton(() => bits[i], toggle && (() => toggle(i)), `${prefix}${i}`), `${prefix}${i}`);
    })));
}

const boxWidth = (label) => Math.max(28, String(label).length * 6.6 + 10);

function drawCircuit(layout, signals, { names = null, live = true, fit = false, onPick = null, picked = null } = {}) {
  const hot = (signal) => live && signals[signal] === 1;
  const pin = (label) => {
    const m = names && /^([xsy])(\d+)$/.exec(label);
    return (m && names[m[1]][Number(m[2])]) || label;
  };
  const curve = (e) => {
    const dx = e.feedback ? 46 : Math.max(20, Math.abs(e.x2 - e.x1) / 2);
    return `M${e.x1},${e.y1} C${e.x1 + dx},${e.y1} ${e.x2 - dx},${e.y2} ${e.x2},${e.y2}`;
  };
  const edges = [...layout.edges].sort((a, b) => hot(a.signal) - hot(b.signal));
  const wires = edges.map((e) => svg("path", { d: curve(e), class: `wire${hot(e.signal) ? " on" : ""}${e.feedback ? " feedback" : ""}` }));
  const nodes = layout.nodes.map((n) => {
    const on = hot(n.kind === "output" ? n.source : n.signal);
    const transform = `translate(${n.x},${n.y})`;
    const mine = picked !== null && picked === (n.kind === "output" ? `y${n.source}` : `${n.kind}${n.signal}`);
    const key = n.kind === "output" ? `y${n.source}` : `${n.kind}${n.signal}`;
    const pickable = onPick ? { onclick: () => onPick(n, key) } : {};
    if (n.kind === "nand") {
      return svg("g", { transform, class: `node${on ? " on" : ""}${mine ? " picked" : ""}${onPick ? " pickable" : ""}`, ...pickable },
        svg("path", { d: "M-11,-9 H-1 A9,9 0 0 1 -1,9 H-11 Z" }),
        svg("circle", { cx: 10.8, cy: 0, r: 2.6 }),
        svg("title", {}, `NAND → ${n.signal} = ${signals[n.signal]}`));
    }
    const rx = n.kind === "output" ? 9 : n.kind === "latch" ? 2 : 5;
    // A named pin ("provoked", "history0") is wider than the 28-unit box that fits x0; the box
    // grows with its label so the name never spills over the edge.
    const w = boxWidth(pin(n.label));
    return svg("g", { transform, class: `node ${n.kind}${on ? " on" : ""}${mine ? " picked" : ""}${onPick ? " pickable" : ""}`, ...pickable },
      svg("rect", { x: -w / 2, y: -9, width: w, height: 18, rx }),
      svg("text", { x: 0, y: 3.5, "text-anchor": "middle" }, pin(n.label)),
      svg("title", {}, `${pin(n.label)} = ${signals[n.kind === "output" ? n.source : n.signal]}`));
  });
  // Room either side for the widest pin, so a long name at the edge is not cut off.
  const pad = Math.max(0, ...layout.nodes.filter((n) => n.kind !== "nand").map((n) => (boxWidth(pin(n.label)) - 28) / 2));
  const width = layout.width + 2 * pad;
  return h("div", { class: fit ? "diagram fit" : "diagram" },
    svg("svg", { width: fit ? "100%" : width, height: fit ? undefined : layout.height, viewBox: `${-pad} 0 ${width} ${layout.height}`, role: "img", "aria-label": t("diagramAria") },
      svg("g", {}, wires), svg("g", {}, nodes)));
}

// ---- step 4: tape-out plan ----------------------------------------------------

function renderTapeout() {
  const r = run.result;
  $("#tapeout-section").hidden = !r || r.composed;
  if (!r || r.composed) return;
  const p = state.plan;
  const field = (key, label, placeholder, hint) => h("label", { class: "field" },
    h("span", {}, label),
    h("input", { value: p[key], placeholder, spellcheck: "false", autocomplete: "off", oninput: (e) => { p[key] = e.target.value; save(); } }),
    hint ? h("small", {}, hint) : null);
  const busy = run.plan?.loading;
  fill($("#tapeout"),
    h("div", { class: "notice" }, t("unsignedNotice")),
    h("div", { class: "plan-form" },
      field("rpc", t("rpc"), "https://…", t("rpcHint")),
      field("processor", t("processor"), "0x…"),
      field("from", t("fromAddr"), "0x…", t("fromHint")),
      field("chainId", t("chainId"), "56", t("chainIdHint")),
      field("implementation", t("implementation"), `0x… (${t("optional")})`, t("implementationHint"))),
    h("div", { class: "actions" }, h("button", { type: "button", class: "primary", disabled: busy, onclick: buildPlan }, busy ? t("reading") : t("buildPlan"))),
    planView());
}

async function buildPlan() {
  const r = run.result;
  const p = state.plan;
  run.plan = { loading: true };
  renderTapeout();
  let outcome;
  try {
    const rpcUrl = p.rpc.trim();
    if (!/^https?:\/\//i.test(rpcUrl)) throw new Error(t("badRpc"));
    const chainText = p.chainId.trim();
    if (chainText && !/^[1-9][0-9]*$/.test(chainText)) throw new Error(t("badChainId"));
    const chain = await readChain({ rpcUrl, processor: p.processor.trim(), from: p.from.trim() });
    const plan = planTapeout({
      name: r.name,
      netlist: r.netlist,
      chain,
      expectChainId: chainText ? Number(chainText) : undefined,
      expectImplementation: p.implementation.trim() || undefined,
    });
    outcome = { plan };
    try {
      outcome.simulation = await simulatePlan({ rpcUrl, plan });
    } catch (error) {
      outcome.simulationError = error.unsupported ? t("simUnsupported") : error.message;
    }
  } catch (error) {
    outcome = { error: error.message, unreachable: /did not answer/.test(error.message) };
  }
  if (r !== run.result) return;
  run.plan = outcome;
  renderTapeout();
}

function manifestCommand() {
  const p = state.plan;
  const r = run.result;
  const parts = [`node scripts/tapeout-manifest.mjs --netlist out/${r.name}/circuit.netlist.json`, `--rpc ${p.rpc.trim() || "URL"}`, `--processor ${p.processor.trim() || "ADDRESS"}`, `--from ${p.from.trim() || "ADDRESS"}`];
  if (p.chainId.trim()) parts.push(`--chain-id ${p.chainId.trim()}`);
  if (p.implementation.trim()) parts.push(`--expect-implementation ${p.implementation.trim()}`);
  return parts.join(" \\\n     ");
}

function planView() {
  const outcome = run.plan;
  if (!outcome || outcome.loading) return null;
  if (outcome.error) {
    return h("div", { class: "error", role: "alert" },
      outcome.error,
      outcome.unreachable ? h("p", {}, t("rpcUnreachable")) : null,
      outcome.unreachable ? h("pre", { class: "cmd" }, manifestCommand()) : null);
  }
  const plan = outcome.plan;
  const sim = outcome.simulation;
  const failed = Boolean(sim && !sim.ok);
  const text = `${JSON.stringify(sim ? { ...plan, simulation: sim } : plan, null, 2)}\n`;
  const units = (wei) => `${formatUnits(wei)} ${t("nativeUnit")}`;
  let simBox;
  if (!sim) {
    simBox = h("div", { class: "stale" }, outcome.simulationError);
  } else if (sim.ok) {
    simBox = h("div", { class: "notice" },
      `✓ ${t("simOk", plan.transactions.length, sim.circuitId, num(sim.gasUsed))}`,
      sim.senderToppedUp ? h("p", { class: "small" }, t("simToppedUp")) : null);
  } else {
    simBox = h("div", { class: "error", role: "alert" },
      t("simFailed"),
      h("ol", {}, sim.calls.map((c) => h("li", {}, `${c.purpose}: ${c.ok ? "ok" : c.error}`))),
      sim.problems.map((problem) => h("p", {}, problem)));
  }
  return h("div", { class: "block" },
    simBox,
    plan.warnings.map((warning) => h("p", { class: "note" }, `⚠ ${warning}`)),
    h("dl", { class: "facts" },
      pair(t("chainId"), plan.chainId),
      pair(t("block"), num(plan.readAtBlock)),
      pair(t("expectedId"), h("span", { class: "mono" }, plan.expectedCircuitId)),
      pair(t("balances"), `NAND ${plan.balances.nand} · LATCH ${plan.balances.latch} · ${units(plan.balances.native)}`),
      plan.supply ? pair(t("supplyLeft"), `${num(plan.supply.left)} / ${num(plan.supply.cap)}`) : null,
      pair(t("fees"), `${t("tapeoutFee")} ${units(plan.fees.tapeoutFee)} · ${t("mintPrice")} ${units(plan.fees.mintPrice)} · ${t("protocolFee")} ${units(plan.fees.protocolFee)}`),
      pair(t("total"), h("strong", {}, units(plan.totalValue))),
      plan.guards.length ? pair(t("guards"), plan.guards.join("; ")) : null),
    h("div", { class: "rows" }, h("table", {},
      h("thead", {}, h("tr", {}, ["#", t("purpose"), t("to"), t("value"), t("data"), sim ? "gas" : null].filter(Boolean).map((label) => h("th", {}, label)))),
      h("tbody", {}, plan.transactions.map((tx, i) => h("tr", {},
        h("td", {}, i + 1),
        h("td", {}, tx.purpose),
        h("td", { class: "mono addr", title: tx.to }, tx.to),
        h("td", { class: "mono" }, units(tx.value)),
        h("td", {}, copyButton(t("copy"), tx.data), h("span", { class: "muted small mono" }, ` ${num((tx.data.length - 2) / 2)} B`)),
        sim ? h("td", { class: "mono" }, sim.calls[i].ok ? num(sim.calls[i].gasUsed) : "✗") : null))))),
    h("p", { class: "note" }, t("idCaveat")),
    failed ? null : h("div", { class: "downloads" },
      copyButton(t("copyPlan"), text),
      h("button", { type: "button", onclick: () => download(`${run.result.name}.tapeout-plan.json`, text) }, `↓ ${t("downloadPlan")}`)));
}

// ---- the everyday flow: say it, check it, prove it, try it ------------------------

const FLOW_STEPS = ["say", "understand", "proof", "try"];
const flow = { screen: "say", reached: 0, showSettings: false, showProgram: false, draft: "", source: null, question: null, note: null, asking: false, picked: null, template: null };

function switchView(view, anchor) {
  state.view = view;
  save();
  renderAll();
  if (anchor) $(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  else window.scrollTo({ top: 0 });
}

function goFlow(screen) {
  flow.screen = screen;
  flow.reached = Math.max(flow.reached, FLOW_STEPS.indexOf(screen));
  renderHeader();
  renderFlow();
  window.scrollTo({ top: 0 });
}

const exprResult = () => (run.result && run.result.kind === "expr" ? run.result : null);

// Which steps can be opened: the sentence always, the check once a program is in the editor,
// and the proof and the try once a circuit exists — including one brought back after a refresh.
function stepOpen(i) {
  if (i === 0) return true;
  if (i === 1) return flow.reached >= 1 || exprStatus(state.expr).ok;
  return Boolean(exprResult());
}

function renderHeader() {
  const inFlow = state.view === "flow";
  const inGallery = state.view === "gallery";
  const inDecide = state.view === "decide";
  $("#decide").hidden = !inDecide;
  const decideButton = $("#decide-switch");
  decideButton.textContent = inDecide ? t("decToFlow") : t("decSwitch");
  decideButton.setAttribute("aria-pressed", String(inDecide));
  $("#workbench").hidden = state.view !== "workbench";
  if (inDecide) { $("#flow").hidden = true; $("#gallery").hidden = true; }
  $("#flow").hidden = !inFlow;
  $("#gallery").hidden = !inGallery;
  const galleryButton = $("#gallery-switch");
  galleryButton.textContent = inGallery ? t("toFlow") : t("toGallery");
  const nav = $("#stepper");
  nav.hidden = !inFlow;
  // The tagline is about the decision flow, so it belongs to that view only - on the gallery
  // it sat under "Things you can make" describing something else entirely.
  $(".tagline").hidden = !inDecide;
  fill(nav, FLOW_STEPS.map((screen, i) => {
    const current = flow.screen === screen;
    return h("button", {
      type: "button",
      class: `step-button${current ? " current" : ""}`,
      "aria-current": current ? "step" : undefined,
      disabled: !stepOpen(i),
      onclick: () => goFlow(screen),
    }, h("span", { class: "step-dot" }, i + 1), h("span", {}, t(`flowStep_${screen}`)));
  }));
  // A version line, so "did it update?" has an answer without guessing.
  const stamp = $(".foot .build");
  if (stamp) stamp.textContent = run.api ? t("buildStamp", run.api.compiler) : "";
  const apiPill = $("#api-pill");
  apiPill.hidden = !run.api;
  if (run.api) {
    apiPill.textContent = t("apiPill", run.api.methods.length);
    apiPill.title = t("apiPillHint", run.api.compiler);
  }
  const d = state.describe;
  const button = $("#model-button");
  // The model is the person's own, and the decision view borrows it to draft a codebook.
  button.hidden = !(inFlow || inDecide);
  button.setAttribute("aria-expanded", String(flow.showSettings));
  // An empty address means the provider's own default - which, for "a model on this computer",
  // is local. Judging by the typed address alone called a local model "no key yet".
  const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(d.baseUrl.trim() || PROVIDERS[d.provider]?.baseUrl || "");
  const ready = local || Boolean(secret.key.trim());
  const label = PROVIDERS[d.provider]?.label[state.lang] ?? PROVIDERS[d.provider]?.label.en ?? d.provider;
  fill(button, h("span", { class: `key-dot${ready ? " ready" : ""}` }), `${label} · ${ready ? (local ? t("modelLocal") : t("modelKeySet")) : t("modelNoKey")}`);
  $("#view-switch").textContent = state.view === "workbench" ? t("toFlow") : t("toWorkbench");
  $("#view-switch").hidden = inGallery;
}

function renderSettings() {
  const box = $("#settings");
  box.hidden = !((state.view === "flow" || state.view === "decide") && flow.showSettings);
  if (box.hidden) return;
  const d = state.describe;
  const model = byokPanel(d, () => {});
  const promptBox = h("pre", { class: "cmd prompt", hidden: true });
  const promptTools = h("div", { class: "toolbar", hidden: true });
  const makePrompt = () => {
    try {
      const prompt = describePrompt(d.sentence);
      promptBox.textContent = prompt;
      promptBox.hidden = false;
      fill(promptTools, copyButton(t("copyPrompt"), prompt));
      promptTools.hidden = false;
    } catch {
      flow.note = { kind: "question", text: t("describeEmpty") };
      renderFlow();
    }
  };
  const useReply = () => {
    const status = $("#settings .reply-status");
    try {
      const question = questionFromReply(d.reply);
      if (question) {
        flow.question = question;
        flow.showSettings = false;
        renderSettings();
        renderHeader();
        goFlow("say");
        return;
      }
      const editor = exprEditorFrom(specFromReply(d.reply));
      const st = exprStatus(editor);
      if (!st.ok && !st.examples.some((e) => e && !e.ok)) throw new Error(st.message);
      adoptProgram(editor, "model");
      d.reply = "";
      flow.showSettings = false;
      renderSettings();
      goFlow("understand");
    } catch (error) {
      status.textContent = `✗ ${t("replyRejected")} ${error.message}`;
    }
  };
  fill(box, h("div", { class: "settings-inner" },
    h("div", { class: "settings-col" },
      h("h2", {}, t("settingsModelTitle")),
      model.settings),
    h("div", { class: "settings-col narrow" },
      h("h2", {}, t("noKeyTitle")),
      h("p", { class: "note" }, t("describeNote")),
      h("div", { class: "toolbar" }, h("button", { type: "button", onclick: makePrompt }, t("makePrompt"))),
      promptBox,
      promptTools,
      h("textarea", {
        class: "expr-json",
        rows: 4,
        placeholder: t("replyPlaceholder"),
        "aria-label": t("replyPlaceholder"),
        oninput: (e) => { d.reply = e.target.value; save(); },
      }, d.reply),
      h("div", { class: "toolbar" }, h("button", { type: "button", onclick: useReply }, t("useReply"))),
      h("div", { class: "small disagree reply-status", role: "status" })),
    h("button", { type: "button", class: "ghost close-settings", onclick: () => { flow.showSettings = false; renderSettings(); refresh(); } }, t("close"))));
  // The decision view reads the same settings to say which model will draft, so it follows edits.
  const refresh = () => { renderHeader(); if (state.view === "decide") renderDecide($("#decide"), t); };
  box.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", refresh));
}

function adoptProgram(editor, source) {
  state.expr = editor;
  state.kind = "expr";
  state.compile.names.expr = "";
  flow.source = source;
  flow.showProgram = false;
  flow.question = null;
  flow.note = null;
  if (run.result?.kind === "expr") run.result.stale = true;
  edited();
  renderEditor();
}

async function pickSuggestion(example) {
  const d = state.describe;
  d.sentence = example.sentence[state.lang] ?? example.sentence.en;
  save();
  try {
    await loadExample("expr", example);
    adoptProgram(state.expr, "example");
    state.compile.names.expr = example.id;
    save();
    goFlow("understand");
  } catch (error) {
    flow.note = { kind: "error", text: error.message };
    renderFlow();
  }
}

// One plain question to the model, with no program machinery around it: used for the panel
// naming that the gate reads. Everything about whether the answer is usable is decided in
// src/feasible.mjs, not here.
async function askOnce(prompt, via) {
  const { url, init } = modelRequest({ ...via, messages: [{ role: "user", content: prompt }] });
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const body = await response.json().catch(() => null);
  const text = body?.choices?.[0]?.message?.content ?? body?.content?.[0]?.text ?? "";
  if (!String(text).trim()) throw new Error(`the model gave no answer (${response.status})`);
  return text;
}

async function askFromSentence() {
  const d = state.describe;
  const sentence = d.sentence.trim();
  flow.question = null;
  flow.note = null;
  if (!sentence) {
    flow.question = t("flowNeedSentence");
    return renderFlow();
  }
  const ready = EXAMPLES.flow.find((ex) => Object.values(ex.sentence).includes(sentence));
  if (ready) return pickSuggestion(ready);
  const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(d.baseUrl.trim() || PROVIDERS[d.provider]?.baseUrl || "");
  if (!secret.key.trim() && !local) {
    flow.note = { kind: "question", text: t("needKey") };
    flow.showSettings = true;
    renderSettings();
    renderHeader();
    return renderFlow();
  }
  flow.asking = true;
  flow.gate = null;
  flow.shape = null;
  flow.note = { kind: "muted", text: t("gateChecking") };
  renderFlow();
  const via = { provider: d.provider, baseUrl: d.baseUrl.trim(), model: d.model.trim(), key: secret.key };
  try {
    // First the question no model can answer: can a circuit hold this at all? The model only
    // names what is on the panel; the verdict is code, so a refusal here is a proof and not a
    // guess. Measured: it has never once let through a sentence no circuit can do.
    if (!flow.skipGate) {
      const reply = await askOnce(signalsPrompt(d.sentence), via);
      const verdict = feasibility(signalsFromReply(reply));
      if (verdict.no) {
        flow.asking = false;
        flow.note = null;
        flow.gate = { kind: "no", text: refusalWords(verdict), swaps: verdict.swappable ? verdict.swaps : [], blockers: verdict.impossible.length };
        return renderFlow();
      }
      if (verdict.ask) {
        // Not a refusal - one missing number. Ask for exactly that and nothing else.
        flow.asking = false;
        flow.note = null;
        flow.gate = { kind: "ask", text: verdict.questions[0].says, answer: "" };
        return renderFlow();
      }
    }

    // Then the cheapest road: is this one of the shapes we already have? Picking from a list
    // is a much smaller job than writing a program - measured ten of ten for a typed model and
    // nine of ten for a 7B, against thirty-five percent for writing one from scratch - and a
    // wrong pick costs nothing, because the person reads back what was chosen before anything
    // is built and the circuit is proven either way.
    if (!flow.skipFork) {
      flow.note = { kind: "muted", text: t("forkLooking") };
      renderFlow();
      const picked = forkFromReply(await askOnce(forkPrompt(d.sentence, d.lang), via), d.lang);
      if (picked && picked !== "none") {
        const ask = knobsPrompt(picked, d.sentence, d.lang);
        const wanted = ask ? knobsFromReply(await askOnce(ask, via)) : {};
        const { knobs } = safeKnobs(picked, wanted);
        const built = fromTemplate(picked, knobs, d.lang);
        adoptProgram(exprEditorFrom(built.spec), "template");
        flow.asking = false;
        flow.shape = { id: picked, title: built.title[d.lang] ?? built.title.en, sentence: built.sentence };
        flow.note = { kind: "agree", text: t("forkPicked", flow.shape.title) };
        return goFlow("understand");
      }
    }

    // Otherwise write one. Asking again from a blank page took a small local model from 35% to
    // 80%, so it is the default where the calls are free; on someone's own key it is one try
    // unless they ask for more.
    const restarts = local ? 5 : Number(flow.restarts || 1);
    const result = await askModelBestOf({
      ...via,
      sentence: d.sentence,
      restarts,
      onRestart: (n) => { if (n > 1) { flow.note = { kind: "muted", text: t("gateRestart", n, restarts) }; renderFlow(); } },
      onAttempt: (n) => { flow.note = { kind: "muted", text: t("askingAttempt", n) }; renderFlow(); },
    });
    flow.asking = false;
    if (result.question) {
      flow.note = null;
      flow.question = result.question;
      return renderFlow();
    }
    adoptProgram(exprEditorFrom(result.spec), "model");
    flow.note = { kind: "agree", text: t("askedOk", result.attempts) };
    goFlow("understand");
  } catch (error) {
    flow.asking = false;
    flow.note = { kind: "error", text: error.message };
    renderFlow();
  }
}

// ---- the gallery: the shapes on offer and what this browser has built, each previewable as
// the app it becomes. Compiling for a preview happens in its own worker, so it never disturbs
// the circuit the four steps are working on.
const gallery = { busy: null, showing: null, error: null };

function compileAside(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    worker.addEventListener("message", ({ data }) => {
      if (data.type === "progress") return;
      worker.terminate();
      if (data.type === "error") reject(new Error(data.message));
      else resolve(data);
    });
    worker.addEventListener("error", (event) => { worker.terminate(); reject(new Error(event.message || t("workerFailed"))); });
    worker.postMessage(job);
  });
}

// Where a built app is shown. The local server holds it for a moment and serves it back, because
// under that server's policy a blob would lose the app's own style and script. The website has no
// such server and no such policy, so there a blob is exactly right.
async function previewUrl(html) {
  try {
    const answer = await fetch(new URL("../preview", import.meta.url), { method: "POST", headers: { "content-type": "text/html" }, body: html });
    const body = await answer.json();
    if (body.ok) return body.result.url;
    if (answer.status !== 404 && answer.status !== 405) throw new Error(body.error?.message ?? "preview failed");
  } catch (error) {
    if (!(error instanceof SyntaxError) && !/preview failed|Failed to fetch/.test(error.message)) throw error;
  }
  return URL.createObjectURL(new Blob([html], { type: "text/html" }));
}

async function previewApp(entry) {
  gallery.busy = entry.key;
  gallery.error = null;
  renderGallery();
  if (state.view === "decide") renderDecide($("#decide"), t);
  try {
    const built = await compileAside({ kind: "expr", spec: entry.spec, name: entry.name, steps: entry.steps, seed: entry.seed, sentence: entry.sentence, lang: state.lang });
    const url = await previewUrl(built.files["app.html"]);
    gallery.showing = {
      key: entry.key,
      name: entry.name,
      sentence: entry.sentence,
      url,
      html: built.files["app.html"],
      nand: built.certificate.circuit.nand,
      latch: built.certificate.circuit.latch,
      rows: built.certificate.verification.rowsChecked,
    };
  } catch (error) {
    gallery.error = error.message;
  }
  gallery.busy = null;
  renderGallery();
  if (state.view === "decide") renderDecide($("#decide"), t);
}

function galleryEntries() {
  const fromTemplates = TEMPLATES.map((template) => {
    const built = fromTemplate(template.id, {}, state.lang);
    return {
      key: `t:${template.id}`,
      kind: "template",
      name: template.id,
      title: template.title[state.lang] ?? template.title.en,
      blurb: template.blurb[state.lang] ?? template.blurb.en,
      sentence: built.sentence,
      spec: built.spec,
      steps: undefined,
      seed: undefined,
    };
  });
  const mine = state.history.map((entry) => ({
    key: `h:${entry.name}:${entry.netlistSha256.slice(0, 8)}`,
    kind: "mine",
    name: entry.name,
    title: entry.name,
    blurb: entry.latch ? t("sizeWithLatch", num(entry.nand), num(entry.latch)) : t("sizeNand", num(entry.nand)),
    sentence: entry.sentence,
    spec: entry.spec,
    steps: entry.steps,
    seed: entry.seed,
    entry,
  }));
  return { fromTemplates, mine };
}

function renderGallery() {
  const root = $("#gallery");
  if (!root || state.view !== "gallery") return;
  const { fromTemplates, mine } = galleryEntries();
  const card = (item) => h("article", { class: `gallery-card${gallery.showing?.key === item.key ? " showing" : ""}` },
    h("h3", {}, item.title),
    h("p", { class: "gallery-sentence" }, `“${item.sentence}”`),
    h("p", { class: "note" }, item.blurb),
    h("div", { class: "downloads" },
      h("button", {
        type: "button",
        class: "primary",
        disabled: gallery.busy === item.key || undefined,
        onclick: () => previewApp(item),
      }, gallery.busy === item.key ? t("galleryBuilding") : t("galleryPreview")),
      h("button", {
        type: "button",
        onclick: () => {
          if (item.kind === "mine") return openHistory(item.entry);
          const editor = exprEditorFrom(item.spec);
          state.describe.sentence = item.sentence;
          adoptProgram(editor, "template");
          state.compile.names.expr = item.name;
          save();
          switchView("flow");
          goFlow("understand");
        },
      }, t("galleryOpen"))));

  fill(root,
    h("div", { class: "gallery-head" },
      h("h1", { class: "flow-headline" }, h("span", {}, t("galleryTitle"))),
      h("p", { class: "flow-lead" }, t("galleryLead"))),
    gallery.error ? h("div", { class: "flow-note error" }, gallery.error) : null,
    gallery.showing ? h("section", { class: "flow-card gallery-stage" },
      h("div", { class: "card-head" },
        h("h2", {}, gallery.showing.name),
        h("span", { class: "muted small" }, t("galleryProven", num(gallery.showing.rows), num(gallery.showing.nand)))),
      h("iframe", { class: "app-preview", title: t("appPreviewTitle"), src: gallery.showing.url }),
      h("div", { class: "downloads" },
        h("button", { type: "button", onclick: () => download(`${gallery.showing.name}.app.html`, gallery.showing.html) }, `↓ ${t("appDownload")}`),
        h("button", { type: "button", class: "ghost", onclick: () => { gallery.showing = null; renderGallery(); } }, t("close")))) : null,
    h("h2", { class: "flow-aside-title" }, t("templatesTitle")),
    h("div", { class: "gallery-grid" }, fromTemplates.map(card)),
    mine.length ? h("h2", { class: "flow-aside-title" }, t("historyTitle")) : null,
    mine.length ? h("div", { class: "gallery-grid" }, mine.map(card)) : null);
}

function renderFlow() {
  const root = $("#flow");
  if (!root || state.view !== "flow") return;
  const screens = { say: flowSay, understand: flowUnderstand, proof: flowProof, try: flowTry };
  fill(root, screens[flow.screen]());
}

function noteView() {
  if (!flow.note) return null;
  const cls = { question: "flow-note question", error: "flow-note error", agree: "flow-note agree", muted: "flow-note muted" }[flow.note.kind];
  return h("div", { class: cls, role: "status" }, flow.note.text);
}

// What the gate decided, shown where the person is looking. A refusal says what blocked it
// and what could be used instead; a question asks for the one missing thing and nothing else,
// with a box to answer in - the form that measured best in the programming-by-example work.
function gatePanel() {
  if (!flow.gate) return null;
  if (flow.gate.kind === "no") {
    return h("div", { class: "flow-note error gate-no", role: "status" },
      h("strong", {}, t("gateNoTitle")),
      ...String(flow.gate.text).split("\n").map((line) => h("p", {}, line)),
      // When every blocker has a stand-in, the sentence is one click from being buildable.
      // The swap goes into the sentence rather than happening invisibly, so the person sees
      // what they agreed to and can take it back out.
      flow.gate.swaps?.length
        ? h("div", { class: "gate-swaps" },
            h("p", { class: "muted" }, t("swapOffer", flow.gate.blockers ?? 1)),
            ...flow.gate.swaps.map((sw) => h("button", {
              type: "button",
              class: "primary",
              onclick: () => {
                const d = state.describe;
                d.sentence = `${d.sentence}（${sw.says}）`;
                flow.gate = null;
                save();
                askFromSentence();
              },
            }, sw.says)),
          )
        : null,
      h("button", {
        type: "button",
        class: "link",
        onclick: () => { flow.skipGate = true; flow.gate = null; askFromSentence(); },
      }, t("gateSkip")),
    );
  }
  const box = h("input", {
    type: "text",
    class: "gate-answer",
    value: flow.gate.answer ?? "",
    placeholder: t("gateAnswer"),
    oninput: (e) => { flow.gate.answer = e.target.value; },
    onkeydown: (e) => { if (e.key === "Enter") sendGateAnswer(); },
  });
  return h("div", { class: "flow-note question gate-ask", role: "status" },
    h("strong", {}, t("gateAskTitle")),
    h("p", {}, flow.gate.text),
    h("div", { class: "gate-row" }, box, h("button", { type: "button", class: "primary", onclick: sendGateAnswer }, t("gateSend"))),
  );
}

// The answer becomes part of the sentence, so the program the model writes next has it too -
// and so the person can see exactly what their answer turned into.
function sendGateAnswer() {
  const answer = String(flow.gate?.answer ?? "").trim();
  if (!answer) return;
  const d = state.describe;
  d.sentence = gateAnswerSentence(d.sentence, flow.gate.text, answer);
  flow.gate = null;
  save();
  askFromSentence();
}

function flowSay() {
  const d = state.describe;
  const box = h("textarea", {
    id: "flow-sentence",
    class: "flow-input",
    rows: 3,
    placeholder: t("describePlaceholder"),
    oninput: (e) => { d.sentence = e.target.value; flow.question = null; save(); },
    onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) askFromSentence(); },
  }, d.sentence);
  if (flow.template) {
    return h("div", { class: "flow-say" },
      h("div", { class: "flow-main" }, templatePanel(), noteView()),
      h("aside", { class: "flow-aside" },
        h("h2", { class: "flow-aside-title" }, t("templatesTitle")),
        TEMPLATES.map((template) => h("button", {
          type: "button",
          class: `template-row${template.id === flow.template.id ? " current" : ""}`,
          onclick: () => { flow.template = { id: template.id, params: templateDefaults(template) }; renderFlow(); },
        }, h("span", { class: "template-title" }, template.title[state.lang] ?? template.title.en)))));
  }
  return h("div", { class: "flow-say" },
    h("div", { class: "flow-main" },
      h("h1", { class: "flow-headline" }, h("span", {}, t("flowHeadline1")), h("span", {}, t("flowHeadline2"))),
      h("p", { class: "flow-lead" }, t("flowLead")),
      h("label", { class: "flow-label", for: "flow-sentence" }, t("flowQuestion")),
      box,
      flow.question ? h("div", { class: "flow-note question", role: "status" }, h("strong", {}, t("modelAsksShort")), " ", flow.question) : null,
      gatePanel(),
      h("div", { class: "flow-actions" },
        h("button", { type: "button", class: "primary big", disabled: flow.asking || undefined, onclick: askFromSentence }, flow.asking ? t("asking") : t("flowAsk")),
        h("span", { class: "muted small" }, t("flowAskHint"))),
      noteView()),
    h("aside", { class: "flow-aside" },
      h("h2", { class: "flow-aside-title" }, t("flowTryOne")),
      EXAMPLES.flow.map((ex) => h("button", { type: "button", class: "suggestion", onclick: () => pickSuggestion(ex) },
        h("span", { class: "suggestion-text" }, ex.sentence[state.lang] ?? ex.sentence.en),
        h("span", { class: "suggestion-hint" }, t(`flowHint_${ex.id}`)))),
      templatesView(),
      historyView()));
}

// Starting from a shape instead of a sentence: pick a template, turn its knobs, and the
// program is written here — no model, no key, and the compiler proves it like any other.
function templatesView() {
  if (flow.template) return null;
  return h("section", { class: "templates" },
    h("h2", { class: "flow-aside-title" }, t("templatesTitle")),
    h("p", { class: "note" }, t("templatesNote")),
    TEMPLATES.map((template) => h("button", {
      type: "button",
      class: "template-row",
      onclick: () => { flow.template = { id: template.id, params: templateDefaults(template) }; flow.note = null; renderFlow(); },
    },
    h("span", { class: "template-title" }, template.title[state.lang] ?? template.title.en),
    h("span", { class: "template-blurb" }, template.blurb[state.lang] ?? template.blurb.en))));
}

// The knobs of the template being set up, with the sentence it will carry.
function templatePanel() {
  const chosen = TEMPLATES.find((template) => template.id === flow.template.id);
  let built;
  let problem = null;
  try {
    built = fromTemplate(chosen.id, flow.template.params, state.lang);
  } catch (error) {
    problem = error.message;
  }
  const knob = (p) => h("label", { class: "field small" },
    h("span", {}, p.label[state.lang] ?? p.label.en),
    h("input", {
      type: "number",
      min: p.min,
      max: p.max,
      step: p.step,
      value: String(flow.template.params[p.name]),
      oninput: (e) => {
        const value = Number(e.target.value);
        flow.template.params[p.name] = Number.isInteger(value) ? value : flow.template.params[p.name];
        renderFlow();
      },
    }));
  return h("section", { class: "template-panel" },
    h("div", { class: "card-head" },
      h("h2", {}, chosen.title[state.lang] ?? chosen.title.en),
      h("button", { type: "button", class: "ghost", onclick: () => { flow.template = null; renderFlow(); } }, t("templateBack"))),
    h("p", { class: "note" }, chosen.blurb[state.lang] ?? chosen.blurb.en),
    chosen.params.length ? h("div", { class: "shape" }, chosen.params.map(knob)) : null,
    problem ? h("div", { class: "flow-note error" }, problem) : h("div", { class: "quote small-quote" }, `“${built.sentence}”`),
    h("div", { class: "flow-actions" },
      h("button", {
        type: "button",
        class: "primary big",
        disabled: Boolean(problem) || undefined,
        onclick: () => {
          const editor = exprEditorFrom(built.spec);
          const status = exprStatus(editor);
          if (!status.ok) {
            flow.note = { kind: "error", text: status.message };
            return renderFlow();
          }
          state.describe.sentence = built.sentence;
          adoptProgram(editor, "template");
          state.compile.names.expr = chosen.id;
          flow.template = null;
          save();
          goFlow("understand");
        },
      }, t("templateBuild"))));
}

// The circuits this browser has built before. An entry brings its program back, and rebuilding
// it with the seed and steps the certificate recorded gives the same bytes again.
function historyView() {
  if (!state.history.length) return null;
  return h("section", { class: "history" },
    h("h2", { class: "flow-aside-title" }, t("historyTitle")),
    state.history.slice(0, 8).map((entry) => h("button", {
      type: "button",
      class: "history-row",
      title: t("historyHint", entry.netlistSha256.slice(0, 12)),
      onclick: () => openHistory(entry),
    },
    h("span", { class: "history-name mono" }, entry.name),
    h("span", { class: "history-size mono" }, entry.latch ? `${num(entry.nand)}+${entry.latch}` : num(entry.nand)),
    h("span", { class: "history-sentence" }, entry.sentence || t("flowNoSentence")))),
    state.history.length > 8 ? h("p", { class: "note" }, t("historyMore", state.history.length - 8)) : null,
    h("button", { type: "button", class: "ghost small-button", onclick: () => { state.history = []; state.last = null; save(); renderFlow(); } }, t("historyClear")));
}

// Opens a remembered circuit: its program goes back into the editor, and it is rebuilt with
// the same seed and steps, so the bytes match what it had.
function openHistory(entry) {
  const editor = exprEditorFrom(entry.spec);
  if (!exprStatus(editor).ok) {
    flow.note = { kind: "error", text: exprStatus(editor).message };
    return renderFlow();
  }
  state.describe.sentence = entry.sentence;
  adoptProgram(editor, "history");
  state.compile.names.expr = entry.name;
  state.compile.seed = String(entry.seed);
  state.compile.steps = String(entry.steps);
  state.compile.objective = entry.objective ?? "gates";
  save();
  flow.note = { kind: "muted", text: t("historyOpened", entry.name) };
  goFlow("understand");
}

// The machine, played a few times, in words. Shown before the table, because people read a
// story and skip a table - and the story is what catches "proven, and not what I asked for".
function playLines() {
  let program;
  try {
    program = parseProgram(exprSpec(state.expr));
  } catch (error) {
    // A half-typed program is expected here and says nothing worth showing. Anything else is
    // a bug in this file, and a silent catch is how it stays hidden - this one hid a missing
    // import for an hour.
    if (!(error instanceof Error) || error.name !== "ExprError") console.warn("playLines:", error);
    return null;
  }
  if (!program.inputs.length) return null;
  // The story is about memory: press the same button again and see what it remembers. A
  // program with no state answers the same press the same way every time by construction, so
  // for a vote or a comparison the story was always "presses 1 to 5: still off" followed by
  // "that is usually a misunderstanding" - a false alarm on the simplest circuit there is. Those
  // are checked by the examples beside this instead.
  if (!program.states?.length) return null;
  const lines = narrate(program, { ticks: 5, lang: state.lang });
  if (!lines.length) return null;
  return h("div", { class: "play-lines" },
    h("h3", {}, t("playTitle")),
    h("ol", {}, ...lines.map((l) => h("li", {}, l.text))),
    everMoves(program) ? null : h("p", { class: "flow-note question" }, t("playNever")),
  );
}

function flowUnderstand() {
  const d = state.describe;
  const x = state.expr;
  if (!x.examples) x.examples = [];
  const st = exprStatus(x, state.lang);
  const failing = st.examples.some((e) => e && !e.ok);
  const rows = x.examples.map((row, i) => {
    const v = st.examples[i];
    if (!row.text.trim()) return null;
    const [given, expect] = row.text.split(/\s*->\s*/);
    return h("li", { class: `example-card ${v ? (v.ok ? "ok" : "bad") : ""}` },
      h("span", { class: "example-mark", "aria-label": v ? (v.ok ? t("exampleHolds") : t("exampleFails")) : "" }, v ? (v.ok ? "✓" : "✗") : "·"),
      h("div", { class: "example-body" },
        h("div", { class: "example-line" }, h("span", { class: "mono" }, given), h("span", { class: "arrow", "aria-hidden": "true" }, "→"), h("strong", { class: "mono" }, (expect ?? "").replace(/\bthen\b/, t("thenWord")))),
        v && !v.ok ? h("div", { class: "example-why" }, v.message) : null),
      h("button", { type: "button", class: "ghost icon", "aria-label": t("removeRow"), title: t("removeRow"), onclick: () => { x.examples.splice(i, 1); edited(); renderFlow(); } }, "×"));
  });
  const addInput = h("input", {
    class: "mono",
    placeholder: x.examples.find((row) => row.text.trim())?.text ?? t("examplePlaceholder"),
    value: flow.draft,
    "aria-label": t("addExample"),
    oninput: (e) => { flow.draft = e.target.value; },
    onkeydown: (e) => { if (e.key === "Enter") addDraft(); },
  });
  function addDraft() {
    if (!flow.draft.trim()) return;
    x.examples.push({ text: flow.draft.trim() });
    flow.draft = "";
    edited();
    renderFlow();
  }
  const programText = (() => { try { return specText("expr", specFor("expr", x)); } catch (error) { return error.message; } })();
  return h("div", { class: "flow-understand" },
    h("div", { class: "flow-quote" },
      h("div", { class: "muted" }, t("flowYouSaid")),
      h("div", { class: "quote" }, `“${d.sentence.trim() || t("flowNoSentence")}”`),
      h("div", { class: "muted small" }, t(flow.source === "example" ? "flowFromExample" : flow.source === "history" ? "flowFromHistory" : flow.source === "template" ? "flowFromTemplate" : "flowFromModel"))),
    noteView(),
    h("div", { class: "flow-columns" },
      h("section", { class: "flow-card" },
        h("h2", {}, t("understandTitle")),
        // Everything else on this page checks the circuit against the program. This is the
        // only thing that checks the program against what the person meant - and the four
        // template bugs that shipped were all proven correct and all plainly wrong when
        // played. Nothing here is guessed: every line comes from running the program.
        playLines(),
        // A shape was chosen for them, so say which one and leave the door open. The research
        // on this is blunt: people accept a pick they can reject far more readily than one
        // they have to audit, and the reject has to be one click.
        flow.shape
          ? h("div", { class: "flow-note agree picked-shape", role: "status" },
              h("p", {}, t("forkPicked", flow.shape.title)),
              h("p", { class: "muted" }, flow.shape.sentence),
              h("button", {
                type: "button",
                class: "link",
                onclick: () => { flow.skipFork = true; flow.shape = null; goFlow("say"); askFromSentence(); },
              }, t("forkNotIt")),
            )
          : null,
        st.explain ? h("ol", { class: "readback-big" }, st.explain.lines.map((line) => h("li", {}, line))) : h("p", { class: "disagree" }, st.message),
        st.explain ? st.explain.warnings.map((w) => h("p", { class: "flow-note question small" }, `⚠ ${w}`)) : null,
        h("div", { class: "toolbar" },
          h("button", { type: "button", class: "ghost", "aria-expanded": String(flow.showProgram), onclick: () => { flow.showProgram = !flow.showProgram; renderFlow(); } }, flow.showProgram ? t("hideProgram") : t("showProgram")),
          h("button", { type: "button", class: "ghost", onclick: () => { state.kind = "expr"; switchView("workbench"); } }, t("editInWorkbench"))),
        flow.showProgram ? h("pre", { class: "cmd program" }, programText) : null),
      h("section", { class: "flow-card" },
        h("div", { class: "card-head" },
          h("h2", {}, t("flowCheckTitle")),
          h("span", { class: failing ? "disagree" : "agree" }, failing ? t("flowExamplesBad", st.examples.filter((e) => e && !e.ok).length) : t("flowExamplesOk", st.examplesHold ?? 0))),
        h("ul", { class: "example-list" }, rows),
        h("div", { class: "add-example" }, addInput, h("button", { type: "button", onclick: addDraft }, t("addExample"))),
        h("p", { class: "note" }, failing ? t("flowFailingHelp") : t("flowCheckNote")))),
    h("div", { class: "flow-actions" },
      h("button", { type: "button", class: "primary big", disabled: !st.ok || undefined, onclick: buildFromFlow }, t("flowBuild")),
      h("button", { type: "button", class: "big", onclick: () => goFlow("say") }, t("flowRephrase")),
      !st.ok && !failing ? h("span", { class: "disagree small" }, st.message) : null));
}

function buildFromFlow() {
  state.kind = "expr";
  if (!state.compile.names.expr.trim()) state.compile.names.expr = "my-circuit";
  run.error = null;
  startCompile();
  goFlow("proof");
}

function flowProof() {
  const r = exprResult();
  if (run.worker) {
    return h("div", { class: "flow-proof" },
      h("section", { class: "proof-card working" },
        h("div", { class: "proof-title" }, t("flowBuilding")),
        progressView()));
  }
  if (run.error || !r) {
    return h("div", { class: "flow-proof" },
      h("section", { class: "flow-card" },
        h("div", { class: "error", role: "alert" }, run.error ?? t("flowNothingYet")),
        h("div", { class: "flow-actions" }, h("button", { type: "button", class: "big", onclick: () => goFlow("understand") }, t("flowBackToCheck")))));
  }
  const cert = r.certificate;
  const v = cert.verification;
  const layout = diagramLayout(r.circuit);
  const names = pinNames(cert.expression);
  const zeros = new Array(r.circuit.nIn + 2 + r.circuit.elements.length).fill(0);
  return h("div", { class: "flow-proof" },
    h("section", { class: "proof-card" },
      r.stale ? h("div", { class: "flow-note question" }, t("stale")) : null,
      h("div", { class: "proof-seal" }, h("span", { class: "seal-dot", "aria-hidden": "true" }, "✓"), t("flowProven")),
      h("div", { class: "proof-rows mono" }, `${num(v.rowsChecked - v.wrong)} / ${num(v.rowsChecked)}`),
      h("p", { class: "proof-words" }, cert.circuit.latch ? t("flowProofWordsState", num(v.rowsChecked)) : t("flowProofWords", num(v.rowsChecked))),
      h("div", { class: "proof-tiles" },
        [[cert.circuit.nand, t("tileNand")], [cert.circuit.latch, t("tileLatch")], [cert.expression.examplesHold ?? 0, t("tileExamples")]].map(([n, label]) => h("div", { class: "proof-tile" },
          h("div", { class: "mono" }, num(n)), h("div", {}, label))))),
    h("aside", { class: "flow-aside" },
      h("button", { type: "button", class: "primary huge", onclick: () => goFlow("try") }, t("flowTryIt")),
      h("section", { class: "flow-card" },
        h("div", { class: "card-head" }, h("h2", {}, t("flowLooksLike")), h("span", { class: "muted small" }, circuitSize(cert))),
        layout ? h("div", { class: "thumb" }, drawCircuit(layout, zeros, { names, live: false, fit: true })) : h("p", { class: "note" }, t("tooBigToDraw", num(r.circuit.elements.length))),
        h("p", { class: "note" }, t("flowThumbNote"))),
      appCard(r),
      h("section", { class: "flow-card" },
        h("h2", {}, t("flowTakeIt")),
        h("div", { class: "downloads column" }, Object.entries(r.files).map(([file, text]) => h("button", { type: "button", onclick: () => download(`${r.name}.${file}`, text) }, `↓ ${t(`file_${file.replace(/\W/g, "_")}`)}`)))),
      h("section", { class: "flow-card" },
        h("h2", {}, t("flowChipTitle")),
        h("p", { class: "note" }, t("flowChipNote")),
        h("div", { class: "downloads column" },
          h("button", { type: "button", class: "primary", onclick: () => download(`${r.name}.firsto.json`, r.files["circuit.firsto.json"]) }, `↓ ${t("flowChipDownload")}`),
          copyButton(t("flowChipCopy"), r.files["circuit.firsto.json"]),
          h("a", { class: "chip-link", href: FIRSTO_FLOW_URL, target: "_blank", rel: "noreferrer noopener" }, t("flowChipOpen"))),
        h("ol", { class: "chip-steps" }, [1, 2, 3].map((k) => h("li", {}, t(`flowChipStep${k}`)))),
        chainCheckPanel(r),
        h("details", {},
          h("summary", { class: "small" }, t("flowChipOther")),
          h("p", { class: "note" }, t("flowChipBlifNote")),
          h("div", { class: "downloads" },
            h("button", { type: "button", onclick: () => download(`${r.name}.blif`, r.files["circuit.blif"]) }, `↓ ${t("file_circuit_blif")}`),
            copyButton(t("flowChipCopyBlif"), r.files["circuit.blif"])),
          h("p", { class: "note" }, t("flowChipManualNote")),
          h("button", { type: "button", class: "ghost", onclick: () => switchView("workbench", "#tapeout-section") }, t("flowChipButton")))),
      h("p", { class: "note" }, t("describeCheck"))));
}

const circuitSize = (cert) => (cert.circuit.latch ? t("sizeWithLatch", num(cert.circuit.nand), num(cert.circuit.latch)) : t("sizeNand", num(cert.circuit.nand)));

// Already taped out? Then the chain can be asked to run it, and its answers compared with
// this circuit's. Read-only: it reads the chain and nothing else.
function chainCheckPanel(r) {
  const p = state.plan;
  const status = h("div", { class: "small", role: "status" });
  const field = (key, label, placeholder) => h("label", { class: "field" },
    h("span", {}, label),
    h("input", { value: p[key] ?? "", placeholder, spellcheck: "false", autocomplete: "off", oninput: (e) => { p[key] = e.target.value; save(); } }));
  const button = h("button", { type: "button" }, t("chainCheck"));
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.className = "small muted";
    status.textContent = t("chainChecking");
    try {
      const result = await chainCheck({
        rpcUrl: p.rpc.trim(),
        circuits: (p.circuits ?? "").trim(),
        id: (p.circuitId ?? "").trim(),
        rows: 16,
        netlistHex: r.netlist.netlistHex,
      });
      if (!result.packing) {
        status.className = "small question";
        status.textContent = `? ${result.reason}`;
      } else if (!result.agreed) {
        status.className = "small disagree";
        status.textContent = `✗ ${t("chainDisagrees", num(result.wrong.length), num(result.rowsChecked))}`;
      } else {
        status.className = "small agree";
        status.textContent = `✓ ${t("chainAgrees", num(result.rowsChecked), num(result.rowsTotal))}${result.matchesGiven === true ? ` ${t("chainSameCircuit")}` : result.matchesGiven === false ? ` ${t("chainOtherCircuit", num(result.nand))}` : ""}`;
      }
    } catch (error) {
      status.className = "small disagree";
      status.textContent = `✗ ${error.message}`;
    }
    button.disabled = false;
  });
  return h("details", { class: "chain-check" },
    h("summary", { class: "small" }, t("chainTitle")),
    h("p", { class: "note" }, t("chainNote")),
    h("div", { class: "fields" },
      field("rpc", t("rpc"), "https://…"),
      field("circuits", t("chainContract"), "0x…"),
      field("circuitId", t("chainId"), "5")),
    h("div", { class: "toolbar" }, button, status));
}

// The circuit as a page anyone can open: downloaded, or previewed right here.
function appCard(r) {
  const html = r.files["app.html"];
  const frame = h("iframe", { class: "app-preview", title: t("appPreviewTitle"), hidden: true });
  // The server holds the page for a moment and serves it back, because a blob would inherit
  // this page's policy and lose the app's own style and script.
  const show = async () => {
    try {
      frame.src = await previewUrl(html);
      frame.hidden = false;
    } catch (error) {
      flow.note = { kind: "error", text: `${t("appPreview")}: ${error.message}` };
      renderFlow();
    }
  };
  return h("section", { class: "flow-card" },
    h("div", { class: "card-head" }, h("h2", {}, t("appTitle")), h("span", { class: "muted small" }, t("appSize", Math.round(html.length / 1024)))),
    h("p", { class: "note" }, t("appNote")),
    h("div", { class: "downloads" },
      h("button", { type: "button", class: "primary", onclick: () => download(`${r.name}.app.html`, html) }, `↓ ${t("appDownload")}`),
      h("button", { type: "button", onclick: show }, t("appPreview"))),
    frame);
}

function flowTry() {
  const r = exprResult();
  if (!r) return flowProof();
  const cert = r.certificate;
  const { inputs, outputs } = cert.expression;
  const stateFields = cert.expression.state ?? [];
  const { nIn, nState, nOut } = r.netlist;
  const sim = run.sim;
  const step = simulate(r.circuit, sim.inputs, Uint8Array.from(sim.state));
  const x = valueOf(sim.inputs);
  const s = valueOf(sim.state);
  const packed = r.table.ys[x + s * 2 ** nIn];
  const want = { y: packed % 2 ** nOut, next: Math.floor(packed / 2 ** nOut) };
  const got = { y: valueOf([...step.outputs]), next: valueOf([...step.newState]) };
  const agrees = got.y === want.y && (nState === 0 || got.next === want.next);
  const values = unpackFields(inputs, x);
  const setInput = (i, v) => {
    const max = 2 ** inputs[i].width - 1;
    values[i] = Math.max(0, Math.min(max, v));
    sim.inputs = bitsOf(packFields(inputs, values), nIn);
    renderFlow();
  };
  const controls = inputs.map((f, i) => (f.width === 1
    ? h("button", { type: "button", class: `big-toggle${values[i] ? " on" : ""}`, "aria-pressed": String(Boolean(values[i])), onclick: () => setInput(i, values[i] ? 0 : 1) },
      h("span", { class: "big-toggle-name" }, f.name), h("span", { class: "big-toggle-value mono" }, values[i]))
    : h("div", { class: "stepper-control" },
      h("span", { class: "big-toggle-name" }, f.name),
      h("div", { class: "stepper-row" },
        h("button", { type: "button", "aria-label": `${f.name} −1`, onclick: () => setInput(i, values[i] - 1) }, "−"),
        h("span", { class: "mono stepper-value" }, values[i]),
        h("button", { type: "button", "aria-label": `${f.name} +1`, onclick: () => setInput(i, values[i] + 1) }, "+")))));
  const outValues = unpackFields(outputs, got.y);
  const outs = outputs.map((f, i) => h("div", { class: `big-output${f.width === 1 ? (outValues[i] ? " lit" : " dark") : ""}` },
    h("span", { class: "big-toggle-name" }, f.name),
    h("span", { class: "mono big-output-value" }, outValues[i])));
  const stateBlock = nState ? h("div", { class: "memory" },
    h("div", { class: "memory-values" }, unpackFields(stateFields, s).map((v, i) => h("span", { class: "memory-chip" }, h("span", {}, stateFields[i].name), h("strong", { class: "mono" }, v)))),
    h("button", { type: "button", class: "primary big", onclick: () => { sim.state = [...step.newState]; renderFlow(); } }, t("flowTick")),
    h("button", { type: "button", class: "big", onclick: () => { sim.state.fill(0); renderFlow(); } }, t("reset"))) : null;
  const layout = diagramLayout(r.circuit);
  const names = pinNames(cert.expression);
  const label = (signal) => {
    if (signal === 0 || signal === 1) return `${signal}`;
    const node = layout?.nodes.find((n) => n.signal === signal);
    if (!node) return t("gateNumber", signal);
    const m = /^([xsy])(\d+)$/.exec(node.label ?? "");
    return m ? names[m[1]][Number(m[2])] ?? node.label : t("gateNumber", signal);
  };
  const inspect = (node) => {
    const value = step.signals[node.kind === "output" ? node.source : node.signal];
    if (node.kind === "nand") {
      const element = r.circuit.elements.find((e) => e.out === node.signal);
      const a = step.signals[element.a];
      const b = step.signals[element.b];
      return t("gateNand", label(element.a), a, label(element.b), b, value);
    }
    if (node.kind === "latch") return t("gateLatch", label(node.signal), value, step.signals[r.circuit.elements.find((e) => e.out === node.signal).d]);
    if (node.kind === "output") return t("gateOutput", label(node.source), value);
    if (node.kind === "input") return t("gateInput", label(node.signal), value);
    return t("gateConst", value);
  };
  const pickedNode = flow.picked && layout ? layout.nodes.find((n) => (n.kind === "output" ? `y${n.source}` : `${n.kind}${n.signal}`) === flow.picked) : null;
  // A few ticks ahead, from the state on screen, with the inputs held: what the circuit does over time.
  const waveform = () => {
    const ticks = [];
    let here = Uint8Array.from(sim.state);
    for (let k = 0; k < 8; k++) {
      const shot = simulate(r.circuit, sim.inputs, here);
      ticks.push({ state: [...here], outputs: [...shot.outputs] });
      here = Uint8Array.from(shot.newState);
    }
    const rows = [
      ...stateFields.map((f, i) => ({ name: f.name, kind: "state", cells: ticks.map((tick) => unpackFields(stateFields, valueOf(tick.state))[i]) })),
      ...outputs.map((f, i) => ({ name: f.name, kind: "out", cells: ticks.map((tick) => unpackFields(outputs, valueOf(tick.outputs))[i]) })),
    ];
    return h("div", { class: "waveform" },
      h("div", { class: "card-head" }, h("h3", {}, t("waveTitle")), h("span", { class: "muted small" }, t("waveHint"))),
      h("div", { class: "rows" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, t("waveName")), ticks.map((_, k) => h("th", { class: "mono" }, k)))),
        h("tbody", {}, rows.map((row) => h("tr", {},
          h("td", { class: `mono ${row.kind}` }, row.name),
          row.cells.map((value) => h("td", { class: "mono wave-cell" }, value))))))));
  };
  return h("div", { class: "flow-try" },
    h("section", { class: "flow-card try-main" },
      h("h2", { class: "flow-h2" }, t("flowTryTitle")),
      h("p", { class: "muted" }, t("flowTrySub")),
      h("div", { class: "try-row" },
        h("div", { class: "try-inputs" }, controls),
        h("span", { class: "try-arrow", "aria-hidden": "true" }, "→"),
        h("div", { class: "try-outputs" }, outs)),
      stateBlock,
      h("div", { class: "card-head" }, h("h3", {}, t("flowLiveTitle")), h("span", { class: "muted small" }, nState ? t("flowLiveCaptionState") : t("flowLiveCaption"))),
      layout ? h("div", { class: "live" }, drawCircuit(layout, step.signals, {
        names,
        fit: true,
        picked: flow.picked,
        onPick: (_node, key) => { flow.picked = flow.picked === key ? null : key; renderFlow(); },
      })) : h("p", { class: "note" }, t("tooBigToDraw", num(r.circuit.elements.length))),
      layout ? h("div", { class: pickedNode ? "flow-note question" : "note" }, pickedNode ? inspect(pickedNode) : t("gatePickHint")) : null,
      nState ? waveform() : null,
      h("div", { class: agrees ? "flow-note agree" : "flow-note error", role: "status" }, agrees ? `✓ ${t("flowAgrees")}` : `✗ ${t("disagrees")}`)),
    h("aside", { class: "flow-aside" },
      h("section", { class: "flow-card" },
        h("h2", {}, t("flowYourSentence")),
        h("div", { class: "quote small-quote" }, `“${state.describe.sentence.trim() || t("flowNoSentence")}”`)),
      h("section", { class: "flow-card legend" },
        h("h2", {}, t("flowHowToRead")),
        h("div", { class: "legend-row" }, svg("svg", { width: 40, height: 28, viewBox: "-16 -14 32 28", "aria-hidden": "true", class: "legend-nand" }, svg("path", { d: "M-11,-9 H-1 A9,9 0 0 1 -1,9 H-11 Z" }), svg("circle", { cx: 10.8, cy: 0, r: 2.6 })), h("span", {}, t("legendNand"))),
        h("div", { class: "legend-row" }, svg("svg", { width: 40, height: 28, viewBox: "-20 -14 40 28", "aria-hidden": "true", class: "legend-latch" }, svg("rect", { x: -15, y: -10, width: 30, height: 20, rx: 2 })), h("span", {}, t("legendLatch"))),
        h("div", { class: "legend-row" }, svg("svg", { width: 40, height: 28, viewBox: "0 0 40 28", "aria-hidden": "true", class: "legend-wire" }, svg("path", { d: "M2 14h36" })), h("span", {}, t("legendWire"))),
        h("div", { class: "mono" }, circuitSize(cert))),
      h("button", { type: "button", class: "big", onclick: () => { state.describe.sentence = ""; flow.reached = 0; flow.note = null; save(); goFlow("say"); } }, t("flowStartOver"))));
}

// ---- wiring -------------------------------------------------------------------

function renderAll() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel));
  renderHeader();
  renderSettings();
  renderFlow();
  renderGallery();
  if (state.view === "decide") renderDecide($("#decide"), t);
  for (const button of document.querySelectorAll("[data-lang]")) button.setAttribute("aria-pressed", String(button.dataset.lang === state.lang));
  renderTabs();
  renderEditor();
  renderCompileBar();
  updateProgress();
  renderProof();
  renderCircuit();
  renderTapeout();
}

async function init() {
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => {
      state.lang = button.dataset.lang;
      save();
      renderAll();
    });
  }
  $("#view-switch").addEventListener("click", () => switchView(state.view === "workbench" ? "flow" : "workbench"));
  $("#gallery-switch").addEventListener("click", () => switchView(state.view === "gallery" ? "flow" : "gallery"));
  $("#decide-switch").addEventListener("click", () => { switchView(state.view === "decide" ? "flow" : "decide"); if (state.view === "decide") probeKey().then(renderAll); });
  $("#model-button").addEventListener("click", () => { flow.showSettings = !flow.showSettings; renderSettings(); renderHeader(); });
  useDiagram(drawCircuit);
  useModel(() => {
    const d = state.describe;
    const p = PROVIDERS[d.provider];
    const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test((d.baseUrl || p?.baseUrl || "").trim());
    const model = String(d.model || p?.model || "").trim();
    return { provider: d.provider, baseUrl: d.baseUrl, model, key: secret.key, ready: Boolean(model) && (local || Boolean(secret.key.trim())), label: `${p?.label[state.lang] ?? p?.label.en ?? d.provider}${model ? ` · ${model}` : ""}` };
  }, () => { flow.showSettings = true; renderSettings(); renderHeader(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  // The circuit from the last visit: rebuilt from its own program with the seed and steps its
  // certificate recorded, so the bytes match. Only when that is quick; otherwise it waits for
  // a click in "Built here before".
  if (state.last && state.kind === "expr" && !run.result) {
    const rows = state.last.rows ?? 0;
    if (rows <= 4096) {
      state.compile.names.expr = state.last.name;
      state.compile.seed = String(state.last.seed);
      state.compile.steps = String(state.last.steps);
      flow.reached = 1;
      startCompile();
    }
  }
  // A model already running on this computer means a new sentence needs no key at all.
  const d = state.describe;
  if (!secret.key.trim() && !d.baseUrl.trim()) {
    findLocalModel().then((found) => {
      if (!found || secret.key.trim() || d.baseUrl.trim()) return;
      Object.assign(d, { provider: found.provider, baseUrl: found.baseUrl, model: found.model });
      run.localModel = found;
      save();
      renderHeader();
      renderSettings();
      renderFlow();
    }, () => {});
  }
  // The same address answers a local API; say so when it is switched on.
  // No API at this address means the page is being served as the website (gatecraft.fun), not by
  // npm run ui on this machine - so the footer must not claim "runs on this computer".
  const asWebsite = () => {
    const note = document.querySelector('.foot [data-i18n="footer"]');
    if (note) { note.dataset.i18n = "footerSite"; note.textContent = t("footerSite"); }
  };
  fetch(new URL("../api", import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((body) => {
    if (!body?.ok) asWebsite();
    if (body?.ok) {
      run.api = body.result;
      renderHeader();
    }
  }, asWebsite);
  // Landing straight on the decision view means nothing has asked the server whether a key is
  // sitting in ~/.config yet, so the fill button would look ready and fail on click.
  // Redraw as soon as the probe starts (so the fill button can say "checking") and when it ends.
  if (state.view === "decide") { const probing = probeKey().then(renderAll, () => {}); renderAll(); void probing; }
  window.addEventListener("pointerup", () => stopPainting?.());
  window.addEventListener("pointercancel", () => stopPainting?.());
  renderAll();
  if (!state.seeded) {
    try {
      await loadExample("expr", EXAMPLES.expr[0]);
      await loadExample("grid", EXAMPLES.grid[0]);
      await loadExample("table", EXAMPLES.table[0]);
      await loadExample("fsm", EXAMPLES.fsm[1]);
      state.seeded = true;
      save();
    } catch (error) {
      showEditorError(error);
    }
    renderAll();
  }
}

init();
