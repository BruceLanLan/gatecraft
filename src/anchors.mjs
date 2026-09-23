// Choosing which situations to put to a person.
//
// A person's twenty answers are the scarcest thing in this pipeline - they are the only check
// that catches a decision the model gets confidently wrong, and the only one that cannot be
// automated (two models agree with each other about as often as one model agrees with itself,
// so model-written anchors would quietly turn the correctness check into another consistency
// check). So the twenty are chosen to count for as much as possible:
//
//   - STRATIFIED BY CONFIDENCE. A threshold is calibrated by what happens near it; rows the
//     model is certain about, either way, teach almost nothing.
//   - the model's answer is never carried into the sheet. A person told what the machine said
//     is anchoring on the machine, and the anchor stops being independent of what it checks.
//   - the situation is written in the codebook's own words, never as codes.
import { decodeRow, phrasesOf } from "./decision.mjs";

const BANDS = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]];

export function drawAnchors(d, fill, count = 20, from = "") {
  const answered = fill.rows.filter((r) => r.choice && r.confidence !== undefined);
  if (!answered.length) throw new Error("that fill has no confidences to stratify by");
  const seeded = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const rand = seeded(20260921);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pools = BANDS.map(([lo, hi]) => shuffle(answered.filter((r) => r.confidence >= lo && r.confidence < hi)));
  // Take evenly from the bands that have rows, then keep going round until `count` is reached.
  // Stratifying alone is not enough: a table filled by a stated rule has one confidence for
  // every row, so four of the five bands are empty and a naive share-per-band drew two
  // questions instead of twenty.
  const picked = [];
  const taken = pools.map(() => 0);
  while (picked.length < count && pools.some((p, i) => taken[i] < p.length)) {
    for (const [i, pool] of pools.entries()) {
      if (picked.length >= count || taken[i] >= pool.length) continue;
      picked.push(pool[taken[i]++]);
    }
  }
  picked.sort((a, b) => a.row - b.row);
  return {
    _: `Situations drawn stratified by the model's confidence, which is deliberately NOT recorded here: an anchor told what the machine answered is no longer independent of it. Answer "choice" with one of ${d.choices.map((c) => c.choice).join(" / ")}, or "allow": [...] when more than one is defensible. A null is skipped rather than counted as agreement.`,
    decision: d.name,
    codebook: d.codebookSha256,
    ...(from ? { drawnFrom: from } : {}),
    anchors: picked.map((r) => ({ given: decodeRow(d, r.row), situation: phrasesOf(d, decodeRow(d, r.row)), choice: null, why: "" })),
  };
}
