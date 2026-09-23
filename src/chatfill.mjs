// Asking an ordinary chat model to answer a decision's situations: the prompt, reading the
// answer, and scoring several asks by how often they agree. Pure - no processes, no network -
// so the page can use the same pieces as the command line: the command line sends the prompt
// through the opencode CLI, the page sends it to the person's own provider, and both score it
// the same way. A chat model's self-reported confidence is recorded but, measured, buys nothing;
// see majorityFiller.

export const strip = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

// The last JSON object in the output, so a model that thinks out loud first still parses.
export function lastJson(text) {
  const clean = strip(text);
  let best = null;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < clean.length; j++) {
      if (clean[j] === "{") depth += 1;
      else if (clean[j] === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(clean.slice(i, j + 1));
            if (value && typeof value === "object" && "choice" in value) best = value;
          } catch { /* not JSON, keep looking */ }
          break;
        }
      }
    }
  }
  return best;
}

export function askText(d, situation, scene) {
  const lines = [];
  if (scene ?? d.scene) lines.push(scene ?? d.scene, "");
  lines.push("The situation right now:");
  for (const [field, phrase] of Object.entries(situation)) {
    if (field === "scene") continue;
    lines.push(`- ${field}: ${phrase}`);
  }
  lines.push("", d.question, "", "Your choices:");
  for (const c of d.choices) lines.push(`- ${c.choice}: ${c.phrase}`);
  lines.push(
    "",
    'Answer with one line of JSON and nothing else: {"choice": "<one of the choice names above>", "confidence": <0 to 1, how sure you are>}',
    "Do not use any tools. Do not read or write files. Do not explain.",
  );
  return lines.join("\n");
}

// What a set of confidences is actually made of. A self-reported number that lands on one or
// two values carries no information, and every count that keys off the threshold is then
// meaningless - so this gets printed before anything else is concluded.
export function spread(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  return {
    n: values.length,
    distinct: counts.size,
    modal: sorted[0]?.[0] ?? null,
    modalShare: values.length ? (sorted[0]?.[1] ?? 0) / values.length : 0,
    top: sorted.slice(0, 6).map(([value, count]) => ({ value, count })),
  };
}

// Asking the same situation several times and taking the majority.
//
// The confidence that comes back is HOW OFTEN THE MODEL AGREED WITH ITSELF, not anything the
// model said about itself. That is a measured choice, 2026-09-20, and the measurement is worth
// stating because it replaced the obvious design:
//
//   Scoring by the model's own numbers - mean(all asks) x the winner's share - was compared
//   against five alternatives on two decisions, four independent passes, using per-ask records
//   already on disk so no calls were spent. Asking only "did all N asks agree" keeps far more
//   rows actionable at the same or better reproducibility:
//
//                        rows actionable   of those, reproduce on a repeat
//     comment-hold  self-report   12/48    11/12 = 92%
//                   agreement     28/48    27/28 = 96%
//     refund-call   self-report   34/60    34/34 = 100%
//                   agreement     44/60    43/44 = 98%
//
//   comment-hold was held out: the rule was picked on refund and then beat the incumbent there
//   on BOTH axes. A bare majority (2 of 3) was also tried and is NOT safe - it passes on
//   refund at 93% and fails on comment-hold at 81%, so how permissive you can be is a property
//   of the decision, not something to fix in a default.
//
// So the model's self-reported number buys nothing here and costs half the rows a person could
// act on. It is still recorded per ask, so `tools/score-rules.mjs` can re-score any saved run.
//
// At n = 3 against the usual 0.7 threshold, won/n is exactly "all three agreed". At other n it
// is an agreement rate and nothing above was measured for it.
export function majorityFiller(filler, n = 3, { rule = "agreement" } = {}) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`--asks-per-row must be a whole number of asks, got ${n}`);
  if (!["agreement", "self-report"].includes(rule)) throw new Error(`majority rule must be "agreement" or "self-report", got ${JSON.stringify(rule)}`);
  return async (codes, situation, d) => {
    const asks = [];
    for (let i = 0; i < n; i++) asks.push(await filler(codes, situation, d));
    const votes = new Map();
    for (const a of asks) votes.set(a.choice, (votes.get(a.choice) ?? 0) + 1);
    const [choice, won] = [...votes].sort((x, y) => y[1] - x[1])[0];
    const share = won / asks.length;
    const mean = asks.reduce((s, a) => s + (a.confidence ?? 1), 0) / asks.length;
    const confidence = rule === "agreement" ? share : mean * share;
    // rounded, or every majority lands on its own float and a spread of them looks informative
    return { ...asks[0], choice, confidence: Math.round(1000 * confidence) / 1000, agreement: share, selfReport: Math.round(1000 * mean) / 1000, asks: asks.map((a) => ({ choice: a.choice, confidence: a.confidence })) };
  };
}

// A filler over any transport: `ask(prompt)` returns the model's text. The command line passes
// one that runs opencode; the page passes one that calls the person's own provider. Retries a
// reply that does not parse or names no declared choice, and says why when it gives up.
export function textFiller(d, { ask, source = "chat", model = null, retries = 2, scene = null, onAsk }) {
  const names = new Set(d.choices.map((c) => c.choice));
  return async (codes, situation) => {
    let last = null;
    for (let go = 0; go <= retries; go++) {
      onAsk?.();
      try {
        const answer = lastJson(await ask(askText(d, situation, scene)));
        if (!answer) throw new Error("no JSON object with a choice in the reply");
        if (!names.has(answer.choice)) throw new Error(`choice ${JSON.stringify(answer.choice)} is not one of the declared choices`);
        const confidence = Number(answer.confidence);
        return { choice: answer.choice, confidence: confidence >= 0 && confidence <= 1 ? confidence : 0.5, source, ...(model ? { model } : {}) };
      } catch (error) { last = error; }
    }
    throw last ?? new Error("no attempt was made");
  };
}
