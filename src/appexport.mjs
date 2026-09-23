// A proven circuit as a web app someone can actually use: one self-contained .html file that
// opens by double-clicking, runs the circuit gate by gate in the page, and needs no server,
// no network and no build step. This is what turns "I described a behaviour" into "here, try
// it" - the file can be sent to anyone.
//
// The file carries the element list (so it runs), the canonical netlist bytes and the proof
// numbers (so it can say what it is), and the program's own names (so its controls read like
// the sentence). Nothing else: no fonts, no scripts, no images from anywhere.
import { OPCODE, decodeCircuit, hexToBytes } from "./netlist.mjs";

// Controls are chosen from the program's own shape: one bit is a switch or a lamp, several
// bits are a dial or a readout. A skin only changes wording and size, never the behaviour.
export const SKINS = ["auto", "switches", "panel"];

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fields = (list = []) => list.map(({ name, width }) => ({ name, width }));

// The runnable form: gates in emission order (each reads only earlier signals), latches, and
// which signal each output pin reads.
export function circuitProgram(circuit) {
  const gates = [];
  const latches = [];
  for (const element of circuit.elements) {
    if (element.op === OPCODE.NAND) gates.push([element.a, element.b, element.out]);
    else if (element.op === OPCODE.LATCH) latches.push([element.d, element.out]);
    else throw new Error("REF elements cannot be exported as an app");
  }
  return { nIn: circuit.nIn, gates, latches, outputs: [...circuit.outputs] };
}

const RUNTIME = `
const S = new Array(2 + P.nIn + P.gates.length + P.latches.length).fill(0);
S[1] = 1;
let state = P.latches.map(() => 0);
const values = { in: FIELDS.inputs.map(() => 0), state };
function bits(value, width) { return Array.from({ length: width }, (_, i) => (value >> i) & 1); }
function value(list) { return list.reduce((sum, bit, i) => sum + (bit ? 2 ** i : 0), 0); }
function step() {
  let at = 2;
  for (const f of FIELDS.inputs) for (const bit of bits(values.in[FIELDS.inputs.indexOf(f)], f.width)) S[at++] = bit;
  P.latches.forEach(([, out], i) => { S[out] = state[i]; });
  for (const [a, b, out] of P.gates) S[out] = 1 - (S[a] & S[b]);
  return {
    outputs: P.outputs.map((signal) => S[signal]),
    next: P.latches.map(([d]) => S[d]),
  };
}
function split(bitsList, list) {
  let at = 0;
  return list.map((f) => { const v = value(bitsList.slice(at, at + f.width)); at += f.width; return v; });
}
function render() {
  const now = step();
  const outs = split(now.outputs, FIELDS.outputs);
  FIELDS.outputs.forEach((f, i) => {
    const el = document.getElementById("out-" + i);
    if (f.width === 1) {
      el.classList.toggle("lit", outs[i] === 1);
      el.querySelector(".v").textContent = outs[i] ? ON_WORD : OFF_WORD;
    } else {
      el.querySelector(".v").textContent = outs[i];
    }
  });
  FIELDS.inputs.forEach((f, i) => {
    const el = document.getElementById("in-" + i);
    if (f.width === 1) {
      el.classList.toggle("on", values.in[i] === 1);
      el.setAttribute("aria-pressed", String(values.in[i] === 1));
      el.querySelector(".v").textContent = values.in[i];
    } else {
      el.querySelector(".v").textContent = values.in[i];
    }
  });
  const memory = document.getElementById("memory-values");
  if (memory) {
    const held = split(state, FIELDS.state);
    memory.innerHTML = FIELDS.state.map((f, i) => '<span class="chip">' + f.name + ' <strong>' + held[i] + "</strong></span>").join("");
  }
}
function tick() {
  state = step().next;
  render();
}
function setInput(i, v) {
  const max = 2 ** FIELDS.inputs[i].width - 1;
  values.in[i] = Math.max(0, Math.min(max, v));
  render();
}
document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-in]");
  if (toggle) {
    const i = Number(toggle.dataset.in);
    const f = FIELDS.inputs[i];
    if (f.width === 1) setInput(i, values.in[i] ? 0 : 1);
    return;
  }
  const step_ = event.target.closest("[data-step]");
  if (step_) {
    const [i, by] = step_.dataset.step.split(",").map(Number);
    setInput(i, values.in[i] + by);
    return;
  }
  if (event.target.closest("#tick")) tick();
  if (event.target.closest("#reset")) { state = P.latches.map(() => 0); render(); }
  const run = event.target.closest("#run");
  if (run) {
    if (window.__timer) { clearInterval(window.__timer); window.__timer = null; run.textContent = RUN_WORD; }
    else { window.__timer = setInterval(tick, 700); run.textContent = STOP_WORD; }
  }
});
render();
`;

// One self-contained page. `lang` picks the wording; everything else comes from the program.
export function appHtml({ name = "circuit", sentence = "", netlist, certificate, expression, skin = "auto", lang = "en" } = {}) {
  if (!SKINS.includes(skin)) throw new Error(`skin must be one of ${SKINS.join(", ")}`);
  const circuit = decodeCircuit(hexToBytes(netlist.netlistHex), netlist.nIn, netlist.nOut);
  const program = circuitProgram(circuit);
  const shape = {
    inputs: fields(expression?.inputs) ?? [],
    state: fields(expression?.state) ?? [],
    outputs: fields(expression?.outputs) ?? [],
  };
  if (!shape.inputs.length) shape.inputs = Array.from({ length: netlist.nIn }, (_, i) => ({ name: `x${i}`, width: 1 }));
  if (!shape.outputs.length) shape.outputs = Array.from({ length: netlist.nOut }, (_, i) => ({ name: `y${i}`, width: 1 }));
  if (!shape.state.length && netlist.nState) shape.state = Array.from({ length: netlist.nState }, (_, i) => ({ name: `s${i}`, width: 1 }));

  const zh = lang === "zh";
  const words = {
    on: zh ? "开" : "on",
    off: zh ? "关" : "off",
    inputs: zh ? "你来拨" : "You set",
    outputs: zh ? "它的回答" : "It answers",
    memory: zh ? "它记住的" : "It remembers",
    tick: zh ? "走一拍" : "Clock tick",
    reset: zh ? "回到开机状态" : "Back to power-on",
    run: zh ? "自动走" : "Run",
    stop: zh ? "停" : "Stop",
    proof: zh
      ? `${certificate.verification.rowsChecked} 种情况全部在电路上验证过 · ${certificate.circuit.nand} 个与非门${certificate.circuit.latch ? ` + ${certificate.circuit.latch} 个存储单元` : ""}`
      : `${certificate.verification.rowsChecked} cases all checked on the circuit · ${certificate.circuit.nand} NAND gates${certificate.circuit.latch ? ` + ${certificate.circuit.latch} memory cells` : ""}`,
    made: zh ? "这颗电路由 gatecraft 编译，并在每一种输入上证明过。双击即可运行，不联网。" : "Compiled by gatecraft and proven on every input. Double-click to run; it uses no network.",
    honest: zh
      ? "逻辑全在电路里。这一页只做两件事：你按一下就替它走一拍，以及在两拍之间替它记住状态——页面不会算任何电路没算的东西。"
      : "All the logic is in the circuit. This page does two things only: it moves the clock when you act, and it holds the state between ticks. It never computes anything the circuit did not.",
    receipt: zh ? "证明" : "Proof",
    receiptRows: zh ? "验证过的情况" : "cases checked",
    receiptGates: zh ? "与非门" : "NAND gates",
    receiptLatch: zh ? "存储单元" : "memory cells",
    receiptNetlist: zh ? "网表 SHA-256" : "netlist SHA-256",
    receiptBuilt: zh ? "编译器与复现" : "compiler and rebuild",
  };

  const control = (f, i) => (f.width === 1
    ? `<button type="button" class="switch" id="in-${i}" data-in="${i}" aria-pressed="false"><span class="n">${escape(f.name)}</span><span class="v">0</span></button>`
    : `<div class="dial" id="in-${i}"><span class="n">${escape(f.name)}</span><div class="row"><button type="button" data-step="${i},-1" aria-label="${escape(f.name)} -1">−</button><span class="v">0</span><button type="button" data-step="${i},1" aria-label="${escape(f.name)} +1">+</button></div></div>`);
  const readout = (f, i) => `<div class="lamp${f.width === 1 ? "" : " wide"}" id="out-${i}"><span class="n">${escape(f.name)}</span><span class="v">0</span></div>`;

  return `<!doctype html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(name)}</title>
<style>
:root { color-scheme: light dark; --bg:#F6F3EA; --panel:#FFFDF7; --ink:#1B1A17; --muted:#5E594F; --line:#E3DDCF; --good:#2E6B4C; --hot:#B4541F; }
@media (prefers-color-scheme: dark) { :root { --bg:#151412; --panel:#1E1C19; --ink:#EDE8DC; --muted:#A39C8D; --line:#34302A; --good:#7CC79B; --hot:#E08A52; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 40px; background:var(--bg); color:var(--ink); font:16px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif; display:flex; flex-direction:column; align-items:center; gap:20px; }
header { max-width:720px; width:100%; display:flex; flex-direction:column; gap:8px; }
h1 { margin:0; font-size:26px; }
.said { font-size:19px; line-height:1.5; }
.proof { display:inline-flex; align-items:center; gap:8px; align-self:flex-start; padding:6px 12px; border-radius:999px; background:var(--panel); border:1px solid var(--line); font-size:13.5px; color:var(--good); }
main { max-width:720px; width:100%; background:var(--panel); border:1px solid var(--line); border-radius:18px; padding:22px; display:flex; flex-direction:column; gap:20px; }
h2 { margin:0; font-size:13px; letter-spacing:0.04em; color:var(--muted); text-transform:uppercase; }
.bank { display:flex; gap:14px; flex-wrap:wrap; }
button { font:inherit; color:var(--ink); background:var(--panel); border:1px solid var(--line); border-radius:12px; cursor:pointer; }
.switch { width:104px; height:104px; border-width:2px; border-radius:18px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; }
.switch.on { background:var(--good); border-color:var(--good); color:#fff; }
.switch .v, .dial .v { font-size:30px; font-weight:600; font-variant-numeric:tabular-nums; }
.n { font-size:13px; font-weight:600; }
.dial { display:flex; flex-direction:column; align-items:center; gap:6px; }
.dial .row { display:flex; align-items:center; gap:8px; }
.dial .row button { width:44px; height:44px; font-size:20px; }
.dial .v { min-width:56px; text-align:center; }
.lamp { min-width:104px; min-height:104px; border-radius:18px; background:#E7E1D3; color:var(--muted); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:0 14px; }
.lamp.lit { background:#F2C14E; color:#3A2800; box-shadow:0 0 38px 6px rgba(242,193,78,.45); }
.lamp.wide { background:var(--ink); color:#F2A65A; }
.lamp .v { font-size:34px; font-weight:600; font-variant-numeric:tabular-nums; }
.clock { display:flex; gap:10px; flex-wrap:wrap; align-items:center; padding:12px; border-radius:14px; background:var(--bg); }
.clock button { min-height:48px; padding:0 18px; }
#tick { background:var(--hot); border-color:var(--hot); color:#fff; font-weight:600; }
.chip { display:inline-flex; gap:6px; align-items:baseline; padding:6px 10px; border-radius:10px; border:2px solid var(--ink); background:var(--panel); margin-right:8px; }
footer { max-width:720px; width:100%; color:var(--muted); font-size:12.5px; }
.receipt { max-width:720px; width:100%; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:12px 16px; font-size:13px; color:var(--muted); }
.receipt summary { cursor:pointer; font-weight:600; color:var(--ink); }
.receipt dl { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:4px 14px; margin:10px 0; }
.receipt dt { color:var(--muted); } .receipt dd { margin:0; overflow-wrap:anywhere; }
.receipt .mono { font-family:ui-monospace,"SF Mono",Menlo,monospace; }
.receipt p { line-height:1.6; margin:8px 0 0; }
</style>
</head>
<body>
<header>
  <h1>${escape(name)}</h1>
  ${sentence ? `<p class="said">“${escape(sentence)}”</p>` : ""}
  <span class="proof">✓ ${escape(words.proof)}</span>
</header>
<main>
  <section>
    <h2>${escape(words.inputs)}</h2>
    <div class="bank">${shape.inputs.map(control).join("")}</div>
  </section>
  <section>
    <h2>${escape(words.outputs)}</h2>
    <div class="bank">${shape.outputs.map(readout).join("")}</div>
  </section>
  ${shape.state.length ? `<section>
    <h2>${escape(words.memory)}</h2>
    <div id="memory-values"></div>
    <div class="clock"><button type="button" id="tick">${escape(words.tick)}</button><button type="button" id="run">${escape(words.run)}</button><button type="button" id="reset">${escape(words.reset)}</button></div>
  </section>` : ""}
</main>
<details class="receipt">
  <summary>${escape(words.receipt)}</summary>
  <dl>
    <dt>${escape(words.receiptRows)}</dt><dd>${escape(String(certificate.verification.rowsChecked))} / ${escape(String(certificate.verification.rowsChecked))}${certificate.verification.wrong ? ` (${escape(String(certificate.verification.wrong))} wrong)` : ""}</dd>
    <dt>${escape(words.receiptGates)}</dt><dd>${escape(String(certificate.circuit.nand))}</dd>
    ${certificate.circuit.latch ? `<dt>${escape(words.receiptLatch)}</dt><dd>${escape(String(certificate.circuit.latch))}</dd>` : ""}
    <dt>${escape(words.receiptNetlist)}</dt><dd class="mono">${escape(certificate.circuit.netlistSha256)}</dd>
    <dt>${escape(words.receiptBuilt)}</dt><dd>${escape(certificate.compiler)}${certificate.reproduce ? ` · seed ${escape(String(certificate.reproduce.seed))} · ${escape(String(certificate.reproduce.steps))} steps` : ""}</dd>
  </dl>
  <p>${escape(words.honest)}</p>
</details>
<footer>${escape(words.made)}</footer>
<script>
const P = ${JSON.stringify(program)};
const FIELDS = ${JSON.stringify(shape)};
const ON_WORD = ${JSON.stringify(words.on)}, OFF_WORD = ${JSON.stringify(words.off)};
const RUN_WORD = ${JSON.stringify(words.run)}, STOP_WORD = ${JSON.stringify(words.stop)};
const NETLIST = ${JSON.stringify(netlist.netlistHex)};
${RUNTIME}
</script>
</body>
</html>
`;
}
