// The first screen of the decision view: what this is, shown rather than told.
//
// The right half is not an illustration. It is comment-hold's proven netlist (built by
// scripts/build-demo.mjs), decoded and simulated here, stepping through situations so the
// wires re-light and the answer changes - the one thing this tool does that nothing else in a
// program does. The left half says it in a sentence and offers two ways in: a guided tour that
// needs nothing, and starting on your own decision.
import { decodeCircuit, hexToBytes, simulate } from "../src/netlist.mjs";
import { diagramLayout } from "./model.mjs";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Situations that walk the answer through every outcome: keep, fold, remove, and a code with
// no phrase, which is handed to a person by construction.
const SCRIPT = [
  { tone: 0, target: 0, provoked: 0, history: 0, stakes: 0 },
  { tone: 1, target: 2, provoked: 0, history: 0, stakes: 0 },
  { tone: 2, target: 2, provoked: 0, history: 0, stakes: 0 },
  { tone: 2, target: 2, provoked: 1, history: 1, stakes: 0 },
  { tone: 2, target: 2, provoked: 1, history: 2, stakes: 1 },
  { tone: 3, target: 0, provoked: 0, history: 0, stakes: 0 },
];

let demo = null;
const loadDemo = () => (demo ??= fetch(new URL("../examples/comment-hold.demo.json", import.meta.url)).then((r) => r.json()).then((d) => ({
  ...d,
  circuit: decodeCircuit(hexToBytes(d.netlist.netlistHex), d.netlist.nIn, d.netlist.nOut),
})));

function pinNames(book) {
  const x = book.observe.flatMap((f) => Array.from({ length: f.width }, (_, i) => (f.width === 1 ? f.field : `${f.field}${i}`)));
  const y = [...Array.from({ length: book.act.bits }, (_, i) => (book.act.bits === 1 ? "action" : `action${i}`)), "review"];
  return { x, s: [], y };
}

function run(d, codes) {
  let row = 0, shift = 0;
  for (const f of d.codebook.observe) { row |= codes[f.field] << shift; shift += f.width; }
  const out = simulate(d.circuit, Array.from({ length: d.netlist.nIn }, (_, i) => (row >>> i) & 1), new Uint8Array(0));
  let code = 0;
  for (let b = 0; b < d.codebook.act.bits; b++) code |= (out.outputs[b] ? 1 : 0) << b;
  const review = Boolean(out.outputs[d.codebook.act.bits]);
  const choice = d.codebook.act.choices[code] ?? d.codebook.act.choices.find((c) => c.choice === d.codebook.act.safe);
  return { signals: out.signals, choice, review };
}

function renderDemo(t, draw) {
  const box = el("div", "land-demo");
  box.append(el("p", "demo-loading", "…"));
  loadDemo().then((d) => {
    const layout = draw ? diagramLayout(d.circuit) : null;
    const names = pinNames(d.codebook);
    let at = 0;
    const paint = () => {
      const codes = SCRIPT[at];
      const r = run(d, codes);
      const lines = el("dl", "demo-situation");
      for (const f of d.codebook.observe.slice(0, 4)) {
        lines.append(el("dt", null, f.field), el("dd", f.values[codes[f.field]] ? null : "unknown", f.values[codes[f.field]] ?? t("landNoPhrase", codes[f.field])));
      }
      const answer = el("div", `demo-answer${r.review ? " reviewing" : ""}`);
      answer.append(el("span", "demo-label", t("landDemoAnswers")), el("strong", null, r.choice.phrase), el("span", "demo-flag", r.review ? t("landDemoReview") : t("landDemoActs")));
      const picture = layout ? draw(layout, r.signals, { names, fit: true }) : el("p", "hint", "");
      const head = el("div", "demo-head");
      head.append(el("span", "demo-q", d.question), el("span", "demo-step mono", `${at + 1} / ${SCRIPT.length}`));
      const next = el("button", "ghost demo-next", t("landDemoNext"));
      next.addEventListener("click", () => { at = (at + 1) % SCRIPT.length; paint(); });
      const foot = el("div", "demo-foot");
      foot.append(el("span", "demo-proof mono", t("landDemoProof", d.proof.nand, d.proof.rows)), next);
      box.replaceChildren(head, lines, answer, picture, foot);
    };
    paint();
    // Step on its own, gently, unless the visitor asked for less motion; stop when the landing is
    // gone (the view re-renders and this node is detached) or while the pointer is on it.
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      let hover = false;
      box.addEventListener("pointerenter", () => { hover = true; });
      box.addEventListener("pointerleave", () => { hover = false; });
      const timer = setInterval(() => {
        if (!box.isConnected) return clearInterval(timer);
        if (!hover) { at = (at + 1) % SCRIPT.length; paint(); }
      }, 2600);
    }
  }).catch(() => box.replaceChildren(el("p", "hint", t("landDemoFailed"))));
  return box;
}

export function renderLanding(t, { draw, onTour, onOwn }) {
  const root = el("section", "landing");

  const hero = el("div", "land-hero");
  const copy = el("div", "land-copy");
  // One clause per line: the break falls where the sentence does, in either language.
  const title = el("h1", "land-title");
  title.append(el("span", null, t("landTitle1")), el("span", null, t("landTitle2")));
  copy.append(title);
  copy.append(el("p", "land-sub", t("landSub")));
  const ctas = el("div", "land-ctas");
  const tour = el("button", "primary big", t("landTour"));
  tour.addEventListener("click", onTour);
  const own = el("button", "ghost big", t("landOwn"));
  own.addEventListener("click", onOwn);
  ctas.append(tour, own);
  copy.append(ctas, el("p", "land-note", t("landFree")));
  hero.append(copy, renderDemo(t, draw));
  root.append(hero);

  // A real sequence, so it is numbered; each step says what you do and one number that is true.
  const how = el("div", "how");
  how.append(el("h2", "section-title", t("landHowTitle")));
  const steps = el("ol", "how-steps");
  for (let i = 1; i <= 5; i++) {
    const li = el("li", "how-step");
    li.append(el("span", "how-num mono", String(i)), el("strong", null, t(`landHow${i}T`)), el("p", null, t(`landHow${i}`)), el("span", "how-detail mono", t(`landHow${i}D`)));
    steps.append(li);
  }
  how.append(steps);
  root.append(how);

  const fit = el("div", "fit");
  fit.append(el("h2", "section-title", t("landFitTitle")));
  const cols = el("div", "fit-cols");
  for (const [kind, n] of [["Yes", 4], ["No", 3]]) {
    const col = el("div", `fit-col fit-${kind.toLowerCase()}`);
    col.append(el("h3", null, t(`landFit${kind}`)));
    const ul = el("ul");
    for (let i = 1; i <= n; i++) ul.append(el("li", null, t(`landFit${kind}${i}`)));
    col.append(ul);
    cols.append(col);
  }
  fit.append(cols);
  const honest = el("p", "fit-honest");
  const link = el("a", null, t("landHonestLink"));
  link.href = "https://github.com/BruceLanLan/gatecraft/blob/main/docs/findings.md";
  link.target = "_blank";
  link.rel = "noopener";
  honest.append(t("landHonest"), " ", link);
  fit.append(honest);
  root.append(fit);
  return root;
}
