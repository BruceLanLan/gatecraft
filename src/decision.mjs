// A decision as the thing delivered: a codebook, a filled table, a proven circuit, and the
// rows a person still has to look at.
//
// The programme this serves (2026-09-20): an ordinary program runs the game, the shop, the
// door; only its DECISIONS go through a circuit. A decision reads a few bits of observation
// and gives back a few bits of action, so it fits in one proof. Where the rule can be written
// down, the expression compiler already freezes it. Where it cannot - where a person can
// recognise the right answer in each situation but not state the rule - the table is filled
// one situation at a time by asking, and this module is the contract around that.
//
// The CODEBOOK is the contract. Each observed field has a width and a phrase for every legal
// code. The phrase is what a model or a person reads; the code is what the circuit reads.
// Bucketing a raw value into a code happens in the caller's program and is documented here,
// not proven here. A code with no phrase is illegal: such rows are never asked, and the
// circuit answers them with the safe action and review = 1 BY CONSTRUCTION. That is the
// fail-closed edge, and it comes from the table, not from any model's judgement.
//
// The FILL is where every answer came from: a stated rule, a decision model with its
// confidence, or a person overriding a row. It is saved as a file and the freeze compiles
// from the file, so the circuit is reproducible even when the model is not. A model answer
// below the confidence threshold keeps its action but sets review = 1, until a person
// confirms or overrides it. The measured reason for that threshold is in
// docs/findings.md (the Jev table): every disagreement with a stated rule sat below 0.7 confidence.
//
// The circuit's outputs are the action code followed by one review bit. decide() packs raw
// codes through the codebook, runs the proven circuit, and unpacks the answer.
import { compileTable } from "./compile.mjs";
import { parseProgram, runProgram } from "./expr.mjs";
import { simulate } from "./netlist.mjs";
import { sha256 } from "./sha256.mjs";

export class DecisionError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecisionError";
  }
}

export const MAX_DECISION_BITS = 16;
export const DEFAULT_THRESHOLD = 0.7;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bitsFor = (max) => Math.max(1, Math.ceil(Math.log2(max + 1)));

// ---------------------------------------------------------------- the codebook

export function parseDecision(spec) {
  if (!spec || typeof spec !== "object") throw new DecisionError("a decision is an object with name, observe, act and question");
  const name = String(spec.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new DecisionError(`"name" must be a short lowercase slug, got ${JSON.stringify(spec.name)}`);
  if (typeof spec.question !== "string" || !spec.question.trim()) throw new DecisionError(`"question" is the one question asked in every situation`);

  const fields = Object.entries(spec.observe ?? {}).map(([field, def]) => {
    if (!IDENT.test(field)) throw new DecisionError(`observed field name ${JSON.stringify(field)} must be a plain identifier`);
    if (!def || !Number.isInteger(def.width) || def.width < 1 || def.width > 8) throw new DecisionError(`observe.${field} needs a "width" of 1..8 bits`);
    const values = new Map();
    for (const [code, phrase] of Object.entries(def.values ?? {})) {
      const c = Number(code);
      if (!Number.isInteger(c) || c < 0 || c >= 2 ** def.width) throw new DecisionError(`observe.${field}: code ${code} does not fit in ${def.width} bits`);
      if (typeof phrase !== "string" || !phrase.trim()) throw new DecisionError(`observe.${field}: code ${code} needs a phrase`);
      values.set(c, phrase.trim());
    }
    if (values.size < 2) throw new DecisionError(`observe.${field} needs at least two legal values with phrases`);
    return { field, width: def.width, values, raw: typeof def.raw === "string" ? def.raw : null };
  });
  if (!fields.length) throw new DecisionError(`"observe" needs at least one field`);
  const nIn = fields.reduce((s, f) => s + f.width, 0);
  if (nIn > MAX_DECISION_BITS) throw new DecisionError(`the observed fields add up to ${nIn} bits; a decision is asked in every situation, so at most ${MAX_DECISION_BITS}`);

  const act = spec.act ?? {};
  const choices = Object.entries(act.choices ?? {}).map(([choice, phrase]) => {
    if (!IDENT.test(choice)) throw new DecisionError(`act choice ${JSON.stringify(choice)} must be a plain identifier`);
    if (typeof phrase !== "string" || !phrase.trim()) throw new DecisionError(`act.choices.${choice} needs a phrase`);
    return { choice, phrase: phrase.trim() };
  });
  if (choices.length < 2) throw new DecisionError(`"act.choices" needs at least two choices`);
  const safe = String(act.safe ?? "");
  if (!choices.some((c) => c.choice === safe)) throw new DecisionError(`"act.safe" must name one of the choices; it is what the circuit answers on a row it must not decide`);
  const actionBits = bitsFor(choices.length - 1);
  const threshold = spec.threshold === undefined ? DEFAULT_THRESHOLD : Number(spec.threshold);
  if (!(threshold >= 0 && threshold <= 1)) throw new DecisionError(`"threshold" must be 0..1`);

  const decision = { name, scene: typeof spec.scene === "string" ? spec.scene.trim() : "", question: spec.question.trim(), fields, nIn, choices, safe, actionBits, threshold };
  decision.codebookSha256 = sha256(codebookText(decision));
  return decision;
}

// The codebook as a stable text, so its hash names exactly this contract.
export function codebookText(d) {
  const lines = [`gatecraft-codebook/1 ${d.name}`];
  for (const f of d.fields) {
    lines.push(`observe ${f.field} width ${f.width}`);
    for (const [code, phrase] of [...f.values].sort((a, b) => a[0] - b[0])) lines.push(`  ${code} = ${phrase}`);
  }
  lines.push(`act ${d.actionBits} bits, safe ${d.safe}`);
  d.choices.forEach((c, k) => lines.push(`  ${k} ${c.choice} = ${c.phrase}`));
  lines.push(`review bit ${d.actionBits}`);
  return `${lines.join("\n")}\n`;
}

export const codebookJson = (d) => ({
  name: d.name,
  sha256: d.codebookSha256,
  observe: d.fields.map((f) => ({ field: f.field, width: f.width, ...(f.raw ? { raw: f.raw } : {}), values: Object.fromEntries([...f.values].sort((a, b) => a[0] - b[0])) })),
  act: { bits: d.actionBits, choices: d.choices.map((c, k) => ({ code: k, choice: c.choice, phrase: c.phrase })), safe: d.safe },
  review: { bit: d.actionBits, meaning: "1 = do not act on the action bits; the situation is illegal, unconfirmed, or unfilled" },
  packing: "observed fields least significant bit first in declaration order; outputs are the action code then the review bit",
});

// ---------------------------------------------------------------- rows

export function decodeRow(d, row) {
  const codes = {};
  let shift = 0;
  for (const f of d.fields) { codes[f.field] = (row >>> shift) & (2 ** f.width - 1); shift += f.width; }
  return codes;
}
export function encodeRow(d, codes) {
  let row = 0, shift = 0;
  for (const f of d.fields) {
    const c = codes[f.field];
    if (!Number.isInteger(c) || c < 0 || c >= 2 ** f.width) throw new DecisionError(`${f.field} = ${JSON.stringify(c)} is not a ${f.width}-bit code`);
    row |= c << shift;
    shift += f.width;
  }
  return row;
}
export const isLegal = (d, codes) => d.fields.every((f) => f.values.has(codes[f.field]));
export const phrasesOf = (d, codes) => Object.fromEntries(d.fields.map((f) => [f.field, f.values.get(codes[f.field]) ?? `(illegal code ${codes[f.field]})`]));

// The situation as it is put to a model or shown to a person: the scene and the phrases.
export const situation = (d, codes) => ({ ...(d.scene ? { scene: d.scene } : {}), ...phrasesOf(d, codes) });

// ---------------------------------------------------------------- filling

// A filler answers one legal situation: { choice, confidence? }. Illegal rows are never asked.
export async function fillDecision(d, filler, { concurrency = 8, onRow, asksPerRow = null } = {}) {
  const rows = new Array(2 ** d.nIn);
  const legal = [];
  for (let row = 0; row < rows.length; row++) {
    const codes = decodeRow(d, row);
    if (isLegal(d, codes)) legal.push(row);
    else rows[row] = { row, source: "illegal" };
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, legal.length)) }, async () => {
    while (next < legal.length) {
      const row = legal[next++];
      const codes = decodeRow(d, row);
      try {
        const answer = await filler(codes, situation(d, codes), d);
        if (!answer || !d.choices.some((c) => c.choice === answer.choice)) throw new DecisionError(`the filler answered ${JSON.stringify(answer?.choice)}, not one of ${d.choices.map((c) => c.choice).join("/")}`);
        rows[row] = { row, choice: answer.choice, ...(answer.confidence !== undefined ? { confidence: Number(answer.confidence) } : {}), source: answer.source ?? "filler", ...(Array.isArray(answer.asks) ? { asks: answer.asks } : {}) };
      } catch (error) {
        rows[row] = { row, source: "failed", error: String(error.message).slice(0, 120) };
      }
      onRow?.(rows[row]);
    }
  }));
  // `asksPerRow` is provenance the bundle has to carry itself: a fill answered once per row
  // holds rows marked actionable that were measured not to reproduce, and whoever freezes it
  // months from now will not remember which it was.
  return { codebook: d.codebookSha256, threshold: d.threshold, ...(asksPerRow ? { asksPerRow } : {}), rows };
}

// A rule may name its choices instead of their codes. Writing the codes is a trap worth
// closing: a code means what it does only because of the order act.choices happens to be
// written in, so reordering that list silently turns "swelling == 1 ? 0 : ..." from "stop
// charging a swollen pack" into "charge it at full current" - measured 2026-09-20 while
// writing a charger decision, and nothing anywhere complained. Naming the choice cannot go
// wrong that way.
export function ruleText(d, expression) {
  if (typeof expression !== "string") throw new DecisionError(`a rule must be an expression written as a string`);
  for (const c of d.choices) {
    if (d.fields.some((f) => f.field === c.choice)) {
      if (new RegExp(`\\b${c.choice}\\b`).test(expression)) throw new DecisionError(`the rule uses "${c.choice}", which is both an observed field and a choice; rename one of them`);
      continue; // the name belongs to the field, and the rule does not mention it
    }
  }
  let text = expression;
  d.choices.forEach((c, code) => {
    if (d.fields.some((f) => f.field === c.choice)) return;
    // A quoted option name is accepted too. The language has no strings at all, so a quote here
    // can only ever have been someone writing `? "remove" :` - which is what both people and
    // drafting models reach for first, and refusing it taught nobody anything.
    text = text.replace(new RegExp(`(["'])${c.choice}\\1`, "g"), String(code));
    text = text.replace(new RegExp(`\\b${c.choice}\\b`, "g"), String(code));
  });
  return text;
}

// A filler that applies a stated rule: an expression over the observed field names whose
// value is the choice's code. A rule that can be written down needs no model.
export function ruleFiller(d, expression) {
  const program = parseProgram({ inputs: Object.fromEntries(d.fields.map((f) => [f.field, f.width])), outputs: { choice: { width: d.actionBits, expr: ruleText(d, expression) } } });
  return (codes) => {
    const k = runProgram(program, codes).choice;
    const choice = d.choices[k];
    if (!choice) throw new DecisionError(`the rule gave ${k}, which names no choice`);
    return { choice: choice.choice, confidence: 1, source: "rule" };
  };
}

// A filler that asks the typed decision model through Cloudflare Workers AI. `fetch` is
// injectable so tests never touch the network; the real one spends the caller's own money.
export function jevFiller(d, { apiKey = null, account = null, token = null, url: override = null, fetch = globalThis.fetch, timeoutMs = 60_000, retries = 3 }) {
  // Two ways to the same model, because the account you need decides whether anyone can
  // start. Direct is one signup at typesafe.ai; the Cloudflare route needs a Cloudflare
  // account with Workers AI on top. Same model, same answers - checked on the same situation,
  // both returned remove at probability 1 - but the request and the reply are shaped
  // differently, so both shapes are handled here rather than in the caller.
  const direct = Boolean(apiKey);
  if (!direct && !(account && token)) throw new DecisionError("the decision model needs TYPESAFE_API_KEY (or ~/.config/gatecraft/jev.token), or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  // `url` points the direct route somewhere that speaks the same request - the free-trial
  // service does, with a trial token in place of a key.
  const url = direct ? (override ?? "https://api.typesafe.ai/v1/systemone") : `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`;
  const criteria = Object.fromEntries(d.choices.map((c) => [c.choice, c.phrase]));
  return async (codes, state) => {
    let lastError;
    for (let go = 0; go <= retries; go++) {
      try {
        const questions = { q: { type: "choice", instructions: d.question, criteria } };
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${direct ? apiKey : token}`, "content-type": "application/json" },
          body: JSON.stringify(direct ? { model: "jev-latest", state, questions } : { model: "typesafe/jev", input: { state, questions } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await response.json();
        if (response.status === 429 || response.status >= 500) throw new Error(`provider answered ${response.status}`);
        const answer = (body.result?.result ?? body.result ?? body).answers?.q;
        if (!answer?.choice) throw new Error(`no answer in ${JSON.stringify(body).slice(0, 120)}`);
        return { choice: answer.choice, confidence: answer.confidence ?? 0, source: "jev" };
      } catch (error) {
        lastError = error;
        if (go < retries) await new Promise((r) => setTimeout(r, 1000 * (go + 1)));
      }
    }
    throw lastError;
  }
}


// ---------------------------------------------------------------- freezing

// Overrides are a person's answers for particular situations, keyed by field codes and
// stamped with the codebook they were written against.
export function applyOverrides(d, fill, overrides) {
  if (!overrides) return fill;
  if (overrides.codebook !== d.codebookSha256) throw new DecisionError(`the overrides were written for codebook ${String(overrides.codebook).slice(0, 12)}…, this decision is ${d.codebookSha256.slice(0, 12)}…; review them against the new codebook first`);
  const rows = fill.rows.map((r) => ({ ...r }));
  for (const o of overrides.rows ?? []) {
    const row = encodeRow(d, o.given ?? {});
    if (!isLegal(d, decodeRow(d, row))) throw new DecisionError(`an override names an illegal situation ${JSON.stringify(o.given)}; illegal codes always review`);
    if (!d.choices.some((c) => c.choice === o.choice)) throw new DecisionError(`override for ${JSON.stringify(o.given)} chooses ${JSON.stringify(o.choice)}, not a choice`);
    rows[row] = { row, choice: o.choice, confidence: 1, source: "human", ...(o.note ? { note: String(o.note) } : {}) };
  }
  return { ...fill, rows };
}

// The table: action code bits then the review bit. Illegal, failed, unfilled and
// low-confidence rows review; the first three also answer the safe action.
export function decisionTable(d, fill) {
  if (fill.codebook !== d.codebookSha256) throw new DecisionError(`the fill was made for codebook ${String(fill.codebook).slice(0, 12)}…, not this one`);
  const nOut = d.actionBits + 1;
  const ys = new Uint32Array(2 ** d.nIn);
  const counts = { legal: 0, illegal: 0, rule: 0, jev: 0, human: 0, filler: 0, failed: 0, unfilled: 0, review: 0 };
  const safeCode = d.choices.findIndex((c) => c.choice === d.safe);
  for (let row = 0; row < ys.length; row++) {
    const r = fill.rows[row];
    const legal = isLegal(d, decodeRow(d, row));
    counts[legal ? "legal" : "illegal"] += 1;
    let code = safeCode;
    let review = 1;
    if (!legal) {
      // by construction
    } else if (!r || r.source === "illegal") {
      counts.unfilled += 1;
    } else if (r.source === "failed" || !r.choice) {
      counts.failed += 1;
    } else {
      counts[r.source in counts ? r.source : "filler"] += 1;
      code = d.choices.findIndex((c) => c.choice === r.choice);
      review = r.source === "human" || r.source === "rule" || (r.confidence ?? 0) >= d.threshold ? 0 : 1;
    }
    if (review) counts.review += 1;
    ys[row] = (code | (review << d.actionBits)) >>> 0;
  }
  return { nIn: d.nIn, nState: 0, nOut, ys, counts };
}

// `anchorFile` is not optional decoration and the certificate says so when it is missing.
// Measured 2026-09-21: of six decisions whose anchors were answered blind (by the AI assistant
// running the measurement as an independent judge - no person has answered them yet), TWO were
// ones where the model disagrees with the judge exactly where it is most confident - and those two
// passed every other check this pipeline has. Row-by-row proof, a second independent proof, a
// reproducible answer and a high confidence all held while the circuit steadily did something
// nobody wanted. A certificate that reports only those four is reporting the half that cannot
// catch it.
export function freezeDecision(d, fill, { overrides = null, steps, seed, anchorFile = null } = {}) {
  const filled = applyOverrides(d, fill, overrides);
  const table = decisionTable(d, filled);
  const { circuit, certificate } = compileTable(table, { steps, seed });
  const fillSha256 = sha256(JSON.stringify(filled.rows));
  const frozen = {
    decision: d,
    fill: filled,
    table,
    circuit,
    certificate: {
      ...certificate,
      decision: {
        name: d.name,
        codebookSha256: d.codebookSha256,
        fillSha256,
        threshold: d.threshold,
        rows: table.counts,
        outputs: { action: `bits 0-${d.actionBits - 1}`, review: `bit ${d.actionBits}` },
        guarantee: "the circuit equals this table on every row; illegal situations review by construction; a model's answer below the threshold reviews until a person confirms it",
        notGuaranteed: "that this table is the policy anyone wanted. The proof relates the circuit to the table and says nothing about the table. Only anchors - situations a person settled without seeing the model's answers - bear on that.",
      },
    },
  };
  // The anchor result goes in last because it needs the frozen table to check against.
  frozen.certificate.decision.policy = anchorFile
    ? (() => { const r = checkAnchors(d, frozen, anchorFile); return { checkedAgainstAPerson: true, anchors: r.checked, held: r.checked - r.broken, contradicted: r.broken, contradictedOnActedRows: r.contradictedOnActedRows, contradictedButReviewing: r.contradictedButReviewing, unanswered: r.unanswered }; })()
    : { checkedAgainstAPerson: false, warning: "nobody has checked this table against a person's own judgements. Two of six decisions checked this way (blind answers by an independent judge - so far an AI assistant, not yet a person) turned out to be ones the filling model gets confidently wrong, and no other check in this pipeline detects that." };
  return frozen;
}

// The rows a person should look at: legal, filled by a model, below the threshold.
export function reviewRows(d, fill) {
  return fill.rows
    .filter((r) => r && r.choice && r.source !== "human" && r.source !== "rule" && (r.confidence ?? 0) < d.threshold)
    .map((r) => ({ given: decodeRow(d, r.row), situation: phrasesOf(d, decodeRow(d, r.row)), model: r.choice, confidence: r.confidence ?? 0 }));
}

// ---------------------------------------------------------------- deciding

// Codes in, action out, through the proven circuit. Nothing here re-decides anything: the
// codebook packs, the circuit answers, the codebook unpacks.
export function decide(frozen, codes) {
  const d = frozen.decision;
  const row = encodeRow(d, codes);
  const inputs = Array.from({ length: d.nIn }, (_, i) => (row >>> i) & 1);
  const out = simulate(frozen.circuit, inputs, new Uint8Array(0));
  let code = 0;
  for (let b = 0; b < d.actionBits; b++) code |= (out.outputs[b] ? 1 : 0) << b;
  const review = out.outputs[d.actionBits] ? 1 : 0;
  const choice = d.choices[code]?.choice ?? d.safe;
  return { action: choice, review, legal: isLegal(d, codes), situation: phrasesOf(d, codes) };
}

// Pin names for the BLIF exports, from the codebook rather than a program.
export function decisionPinNames(d) {
  const x = d.fields.flatMap((f) => Array.from({ length: f.width }, (_, i) => (f.width === 1 ? f.field : `${f.field}${i}`)));
  const y = [...Array.from({ length: d.actionBits }, (_, i) => (d.actionBits === 1 ? "action" : `action${i}`)), "review"];
  return { x, s: [], y };
}

// Anchors: situations a person settled before any model was asked. Freezing a table that
// contradicts one is allowed - people change their minds, and overrides are how that is said -
// but it must never happen quietly, so this returns what held and what did not and the caller
// makes noise. An anchor gives one choice, or the set of choices that are defensible.
export function checkAnchors(d, frozen, anchorFile) {
  const mask = 2 ** d.actionBits - 1;
  const unanswered = [];
  const anchors = (anchorFile?.anchors ?? []).filter((a) => {
    // A drafted anchor sheet arrives with every choice null for a person to fill in. An
    // unanswered one is skipped, never counted as agreement and never as a breach - counting
    // a blank either way would quietly invent an opinion nobody held.
    const blank = !a.choice && !(a.allow?.length);
    if (blank) unanswered.push(a);
    return !blank;
  }).map((a) => {
    const row = encodeRow(d, a.given);
    if (!isLegal(d, decodeRow(d, row))) throw new DecisionError(`an anchor names an illegal situation (row ${row})`);
    const allow = a.allow ?? [a.choice];
    for (const choice of allow) if (!d.choices.some((c) => c.choice === choice)) throw new DecisionError(`an anchor allows ${JSON.stringify(choice)}, which names no choice`);
    const got = d.choices[frozen.table.ys[row] & mask]?.choice ?? null;
    // `given` travels with the report so it can be read back as an anchor sheet: a report you
    // cannot feed to the next step is a dead end, and the exporter hit exactly that.
    return { row, given: decodeRow(d, row), ...phrasesOf(d, decodeRow(d, row)), allow, got, reviewing: Boolean((frozen.table.ys[row] >>> d.actionBits) & 1), held: allow.includes(got), why: a.why ?? null };
  });
  // A contradiction on a row that reviews is the mechanism working: the circuit hands that row
  // to a person and never acts on it. A contradiction on a row it WOULD act on is the alarming
  // kind. Reporting one number for both made two commands look like they disagreed.
  const broken = anchors.filter((a) => !a.held);
  return { codebook: d.codebookSha256, checked: anchors.length, unanswered: unanswered.length, broken: broken.length, contradictedOnActedRows: broken.filter((a) => !a.reviewing).length, contradictedButReviewing: broken.filter((a) => a.reviewing).length, anchors };
}

// The decision at the threshold its calibration chose. The threshold is not part of the
// codebook's hash, so a fill made at one threshold freezes at another; what must never happen
// is a table frozen at the spec's threshold shipping under a header that names the calibrated
// one. That happened in every exporter until 2026-09-23: calibrate to 0.8 because 0.7
// contradicted the person, and the module still acted on the 0.7-0.8 rows - exactly the ones
// the person was shown to disagree with.
export function atThreshold(d, calibration) {
  const t = calibration?.calibratedThreshold;
  return typeof t === "number" && t !== d.threshold ? { ...d, threshold: t } : d;
}

// Can this decision be delegated at all, and if so with the threshold where?
//
// Every setting this pipeline has turned out to be a property of the decision rather than a
// constant of the tool - how much gets settled, how permissive a majority may be, the safe
// threshold, whether the thing can be calibrated at all, and which filling model matches the
// person. There is therefore no global configuration to ship. There is this, run once per
// decision, and it is the only check that catches a decision the model gets confidently
// wrong: measured 2026-09-21, a third of those tried were, and all of them passed row-by-row
// proof, a second independent proof, a repeat and a high confidence while doing it.
//
// `anchors` must have been answered by a person who could not see the model's answers.
export function calibrateThreshold(d, fill, anchorFile, { rule = null, rungs = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3], least = 5 } = {}) {
  if (fill.codebook !== d.codebookSha256) throw new DecisionError(`the fill was made for codebook ${String(fill.codebook).slice(0, 12)}…, not this one`);
  const answered = (anchorFile?.anchors ?? []).filter((a) => a.choice || a.allow?.length);
  const by = new Map(fill.rows.filter((r) => r.choice).map((r) => [r.row, r]));
  let legal = 0;
  for (let row = 0; row < 2 ** d.nIn; row++) if (isLegal(d, decodeRow(d, row))) legal += 1;
  const marks = answered.map((a) => {
    const row = encodeRow(d, a.given);
    if (!isLegal(d, decodeRow(d, row))) throw new DecisionError(`an anchor names an illegal situation (row ${row})`);
    return { row, allow: new Set(a.allow ?? [a.choice]) };
  });
  const sweep = rungs.map((threshold) => {
    const above = marks.filter((m) => by.has(m.row) && by.get(m.row).confidence >= threshold);
    const held = above.filter((m) => m.allow.has(by.get(m.row).choice)).length;
    const settled = [...by.values()].filter((r) => r.confidence >= threshold).length;
    return { threshold, settled, settledShare: legal ? settled / legal : 0, anchorsAbove: above.length, held, clean: above.length >= least && held === above.length };
  });
  const best = sweep.filter((r) => r.clean).sort((a, b) => a.threshold - b.threshold)[0] ?? null;
  let ruleFit = null;
  if (rule && best) {
    const says = ruleFiller(d, rule);
    const st = [...by.values()].filter((r) => r.confidence >= best.threshold);
    const matched = st.filter((r) => says(decodeRow(d, r.row)).choice === r.choice).length;
    ruleFit = { matched, of: st.length, share: st.length ? matched / st.length : null };
  }
  const verdict = !best ? "do-not-delegate" : ruleFit && ruleFit.share > 0.85 ? "write-the-rule-instead" : "delegate";
  // How many different certainties the fill actually contains. A table filled by a stated rule
  // has exactly one, and then the sweep is seven identical rungs: the threshold has nothing to
  // sort, and a caller showing all seven implies a choice that is not there. Callers check this
  // before drawing the sweep as a table.
  const confidences = new Set([...by.values()].map((r) => r.confidence ?? 1));
  // WHY it will not delegate matters as much as that it will not. Two different situations
  // were being reported with one sentence - "it is wrong where it is most confident" - and one
  // of them is not true: on a real run the top four rungs agreed with the person 1/1, 3/3, 3/3
  // and 4/4, and the refusal was only because no rung had the five answers that count as
  // evidence. That is "not enough answers yet", which more answers can fix; "contradicted" is
  // the model disagreeing with the person where it acts, which no amount of answering fixes.
  let why = null, agreesUpTo = null;
  if (!best) {
    const agreeing = sweep.filter((r) => r.anchorsAbove > 0 && r.held === r.anchorsAbove);
    if (agreeing.length || !sweep.some((r) => r.anchorsAbove > 0)) {
      why = "too-few";
      agreesUpTo = agreeing.sort((a, b) => b.anchorsAbove - a.anchorsAbove || a.threshold - b.threshold)[0] ?? null;
    } else why = "contradicted";
  }
  return { anchorsAnswered: answered.length, legal, sweep, calibratedThreshold: best?.threshold ?? null, decides: best ? best.settledShare : null, rule: ruleFit, verdict, why, least, agreesUpTo, confidenceValues: confidences.size };
}
