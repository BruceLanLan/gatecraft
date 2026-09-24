// A guided tour of the decision flow, on a real decision, for someone who has never heard the
// words codebook or anchor.
//
// Each step does the thing it is about - loads the example, reads it back, fills it, pokes the
// circuit - then points at the part of the page that changed and says in one or two sentences
// what just happened and why it matters. It fills from the example's own rule, so it needs no
// key, spends nothing and does not touch the free fills. The page re-renders as the flow moves,
// so the highlight is re-applied after every render rather than held on a node that may be gone.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const cardFor = (n) => `#decide .card[data-step="${n}"]`;

// Each step: where to point, and what to do first. `act` gets the flow's actions.
const STEPS = [
  { key: "Demo", target: "#decide .land-demo" },
  { key: "Codebook", target: "#decide .spec-input", act: (a) => a.loadExample("comment-hold") },
  { key: "Read", target: "#decide .readnotes", act: (a) => a.readBack() },
  { key: "Fill", target: `${cardFor(2)} .result`, act: (a) => a.fillByRule() },
  { key: "Try", target: "#decide .tryit", act: (a) => a.poke({ tone: 2, target: 2 }) },
  { key: "Ask", target: cardFor(3) },
  { key: "Verdict", target: cardFor(4) },
  { key: "Yours", target: "#decide .draft" },
];

export function createTour({ t, actions, rerender }) {
  let at = -1;
  let busy = false;
  let panel = null;

  // Scroll only when the step changes; a re-render caused by the visitor typing or answering
  // must not yank the page back to the highlighted part.
  const focus = (scroll = true) => {
    for (const n of document.querySelectorAll(".tour-focus")) n.classList.remove("tour-focus");
    if (at < 0) return;
    const target = document.querySelector(STEPS[at].target);
    if (!target) return;
    target.classList.add("tour-focus");
    if (scroll) target.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const draw = () => {
    if (at < 0) { panel?.remove(); panel = null; focus(); return; }
    if (!panel) {
      panel = el("aside", "tour");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-live", "polite");
      document.body.append(panel);
    }
    const step = STEPS[at];
    const head = el("div", "tour-head");
    head.append(el("span", "tour-count mono", t("tourCount", at + 1, STEPS.length)));
    const close = el("button", "tour-close", "×");
    close.setAttribute("aria-label", t("tourClose"));
    close.addEventListener("click", stop);
    head.append(close);
    const dots = el("div", "tour-dots");
    STEPS.forEach((_, i) => dots.append(el("span", i === at ? "on" : i < at ? "done" : null)));
    const nav = el("div", "tour-nav");
    const back = el("button", "ghost", t("tourBack"));
    back.disabled = at === 0 || busy;
    back.addEventListener("click", () => go(at - 1, { replay: false }));
    const next = el("button", "primary", busy ? t("tourWorking") : at === STEPS.length - 1 ? t("tourDone") : t("tourNext"));
    next.disabled = busy;
    next.addEventListener("click", () => (at === STEPS.length - 1 ? stop() : go(at + 1)));
    nav.append(back, next);
    panel.replaceChildren(head, el("h3", "tour-title", t(`tour${step.key}T`)), el("p", "tour-body", t(`tour${step.key}`)), dots, nav);
    focus();
  };

  async function go(i, { replay = true } = {}) {
    if (i < 0 || i >= STEPS.length || busy) return;
    at = i;
    if (replay && STEPS[i].act) {
      busy = true; draw();
      try { await STEPS[i].act(actions); } catch { /* the step still explains; the page shows any error */ }
      busy = false;
      rerender();
    }
    draw();
  }

  function stop() { at = -1; draw(); }

  return {
    start: () => go(0),
    stop,
    // The view re-renders on its own (typing, answers, polling); put the highlight back each time.
    refocus: () => { if (at >= 0) focus(false); },
    get running() { return at >= 0; },
  };
}
