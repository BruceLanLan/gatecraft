// Drafting a codebook from one sentence, and then making a person look at it.
//
// Writing a decision by hand means a forty-line JSON with bit widths, and nobody starts there.
// A model drafts it in one call; what matters is what happens next, because the model is not
// allowed to be the judge of its own draft:
//
//   - `parseDecision` decides whether the shape is legal. Measured 2026-09-21: 24 of 24 drafts
//     passed it, so the shape is not where drafts go wrong.
//   - the buckets are where they go wrong, and no code can settle that. What code CAN do is
//     point at the ones that smell: a bucket the caller cannot compute without reading free
//     text, knowing who someone is, going to the network or looking at a clock is the wall
//     this whole tool stops at, and a draft that quietly crosses it produces a circuit that
//     cannot be wired to anything.
//   - `safe` is the field a model gets wrong in a way that matters. Measured on a CNC draft:
//     it chose "keep the current feed rate" as safe, reading safe as "least surprising", when
//     the least damaging thing to do with an unknown sensor code is to retract the tool.
//
// So this returns the draft plus a list of things for a person to look at, and the caller is
// expected to show them rather than swallow them.
import { parseDecision } from "./decision.mjs";

// Words in a bucket's own description that mean it lives on the far side of the wall.
//
// The text pattern used to include the bare nouns - text, message, comment, sentence. That
// looked right until the notes were put somewhere people actually read them, and every field of
// the comment-hold example lit up: in a decision ABOUT a comment, every description says the
// word "comment", and only one of those fields needs anyone to read one. A check that fires on
// all five teaches people to ignore it, which is worse than not having it. So it now looks for
// the act of reading rather than for the noun being read, and it will miss a bucket that needs
// understanding without saying so.
const SMELLS = [
  [/\b(free.?form|free.text|raw text|the text\b|wording|phrasing|sentiment|nlp|embedding|classifier|language model|how (?:it|the \w+) is (?:written|phrased|worded)|what (?:it|the \w+) says)\b/i, "reads free text"],
  [/\b(name|email|identity|who the|user id|account id|customer id|person's)\b/i, "needs to know who someone is"],
  [/\b(api|endpoint|http|fetch|request to|look ?up in|third.?party|external service)\b/i, "calls out to something"],
  [/\b(timestamp|clock|current time|time of day|date|calendar|utc)\b/i, "looks at a clock"],
];

const VAGUE = /\b(based on|considering|depending on|according to|the (?:current |overall |general )?(?:state|situation|condition|context) of|in general|overall|assess(?:ed|ment)?|judg(?:ed|ement|ment)|estimat(?:e|ed|ion)|determined by|seems?)\b/i;

export function reviewDraft(spec) {
  const d = parseDecision(spec); // throws if the shape is illegal at all
  const notes = [];
  for (const f of d.fields) {
    const raw = String(spec.observe?.[f.field]?.raw ?? "");
    const across = SMELLS.find(([re]) => re.test(raw) || re.test(f.field));
    if (across) {
      notes.push({ about: f.field, kind: "bucket", says: `"${f.field}" may be on the far side of the wall: its description ${across[1]}. The caller has to be able to compute this bucket from what it already has - if it cannot, drop the field or bucket it differently.` });
    } else if (VAGUE.test(raw) || !raw.trim()) {
      // The softer miss. A description that names no source at all - "based on the current
      // state of the street", which a 7B model wrote for traffic density on its first real
      // draft - does not cross the wall in so many words, so the check above passes it in
      // silence. But nobody can wire a circuit to "the state of the street". Not an
      // accusation, a request: say what the program actually reads.
      notes.push({ about: f.field, kind: "vague", says: `"${f.field}" does not say where its value comes from${raw.trim() ? ` ("${raw.trim()}")` : ""}. Write down what your program actually reads to pick the code - a sensor, a stored flag, a count - or this bucket is a guess the circuit will be wired to.` });
    }
    if (f.values.size === 2 ** f.width) notes.push({ about: f.field, kind: "bucket", says: `"${f.field}" uses every code its width allows, so no code is illegal. That is fine, but it means this field can never make a row fail closed.` });
  }
  const safe = d.choices.find((c) => c.choice === d.safe);
  notes.push({ about: "safe", kind: "safe", says: `"safe" is ${JSON.stringify(d.safe)} - ${safe.phrase}. It is what the circuit answers on a row it must not decide, so the question is "if someone acted on this by mistake, could we live with it", NOT "which is usually right". A model drafting this tends to pick the least surprising option instead of the least damaging one.` });

  let legal = 1;
  for (const f of d.fields) legal *= f.values.size;
  return { decision: d, legal, rows: 2 ** d.nIn, notes };
}

// Bit widths are arithmetic, not judgement, and a model should not be failed for getting them
// wrong. Measured 2026-09-23 with a 7B local model: two drafts in a row rejected, both for
// "code 2 does not fit in 1 bits" - the meaning was fine, the counting was not. So a width too
// small for the codes that were given phrases is widened to the least that fits, and every such
// change is reported so the read-back can say it. Widening only ever adds codes with no phrase,
// which are illegal and review by construction - it cannot change what any phrased code means.
// A width that is too LARGE is left alone: that is a choice (room to grow), not a mistake.
export function settleWidths(spec) {
  const fixed = [];
  if (!spec || typeof spec !== "object" || !spec.observe || typeof spec.observe !== "object") return { spec, fixed };
  const out = structuredClone(spec);
  for (const [field, f] of Object.entries(out.observe)) {
    const codes = Object.keys(f?.values ?? {}).map(Number).filter((c) => Number.isInteger(c) && c >= 0);
    if (!codes.length) continue;
    const needs = Math.max(1, Math.ceil(Math.log2(Math.max(...codes) + 1)));
    if (!Number.isInteger(f.width) || f.width < needs) {
      fixed.push({ field, from: f.width ?? null, to: needs });
      f.width = needs;
    }
  }
  return { spec: out, fixed };
}

// The codebook as sentences a person can check without reading JSON.
export function readBack(spec) {
  const { decision: d, legal, rows, notes } = reviewDraft(spec);
  const lines = [`${d.name}: ${d.nIn} bits, ${legal} legal situations of ${rows}`, ""];
  if (d.scene) lines.push(`  ${d.scene}`, "");
  lines.push(`  Asked about every one of them: ${d.question}`, "");
  for (const f of d.fields) {
    const illegal = 2 ** f.width - f.values.size;
    lines.push(`  ${f.field}${illegal ? `  (${illegal} unused code${illegal === 1 ? "" : "s"}, which review by construction)` : ""}`);
    for (const [code, phrase] of [...f.values].sort((a, b) => a[0] - b[0])) lines.push(`      ${code} = ${phrase}`);
  }
  lines.push("", "  It can answer:");
  for (const c of d.choices) lines.push(`      ${c.choice}${c.choice === d.safe ? "  (the safe one)" : ""} - ${c.phrase}`);
  if (notes.length) {
    lines.push("", "  Look at these before filling anything:");
    for (const n of notes) lines.push(`      - ${n.says}`);
  }
  return lines.join("\n");
}

// The one prompt that turns a sentence into a codebook. Shared so the product command and the
// research tool cannot drift apart.
export const codebookPrompt = (line) => `Here is a decision a running program makes over and over:

${line}

Write it as a JSON decision file in exactly this shape:

{
  "name": "short-lowercase-slug",
  "scene": "two or three sentences a reviewer reads before being asked about one case: what the system is, and what it costs to get this decision wrong in each direction",
  "question": "the one question asked about every single case, in plain words",
  "observe": {
    "field_name": { "width": 2, "raw": "how the program computes this bucket from what it has", "values": { "0": "a phrase a person would say", "1": "another", "2": "another" } }
  },
  "act": { "choices": { "option_a": "what this option does", "option_b": "..." }, "safe": "option_a" },
  "threshold": 0.7
}

Hard requirements:
- 4 to 6 observed fields. Each field has "width" of 1, 2 or 3 bits and between 2 and 8 values. Codes start at 0 and must fit the width (width 2 allows codes 0-3). Leaving a code out is fine and means that code is illegal.
- Every value is a phrase in plain words, never a number or a code name.
- Every bucket must be computable from what the program already has WITHOUT reading free text, identifying a person, calling the network, or looking at a clock. If the original variable was text or a timestamp, bucket it into something concrete (for example "arrived in the last few minutes") or leave that variable out.
- The observed fields must add up to at most 14 bits in total.
- "safe" names the option that does LEAST DAMAGE if someone acted on it by mistake - not the one you think is most often right, and not the one that changes least.
- 2 to 4 options in "act".

Reply with the JSON object and nothing else. Do not use any tools. Do not explain.`;
