// When a rewritten scene counts as an improvement.
//
// This is the only thing standing between "the model improves its own prompt" and "the model
// learns to say it is confident". It is a separate file because it is the load-bearing rule of
// the experiment and is tested on its own.
//
// A round is accepted only when all three hold:
//   1. every anchor a person settled beforehand still holds. A scene that buys confidence by
//      being harsher or laxer breaks these first.
//   2. strictly fewer rows came back unsure than in the best round so far. Not "no worse" -
//      a rewrite that changes nothing should not be accepted.
//   3. where a rule can be written at all, agreement with it on the rows the model was SURE
//      about does not go down. Without this, (2) alone is satisfied by "be decisive".
//
// (3) is skipped where there is no rule, which is exactly the decisions this pipeline is for.
// There, (1) is the whole guard, and the anchor list has to be long enough to feel a 10% slide.
export function acceptRound(best, s) {
  if (!best) return { accepted: true, why: "baseline" };
  if (s.anchorsBroken.length) return { accepted: false, why: `rejected: ${s.anchorsBroken.length} anchors broken` };
  if (!(s.unsure < best.unsure)) return { accepted: false, why: `rejected: unsure rows ${best.unsure} -> ${s.unsure}, not fewer` };
  if (s.ruleAgreeSure !== null && best.ruleAgreeSure !== null && best.ofSure > 0) {
    const now = s.ofSure ? s.ruleAgreeSure / s.ofSure : 0;
    const before = best.ruleAgreeSure / best.ofSure;
    if (now < before) return { accepted: false, why: `rejected: agreement with the rule on sure rows ${(100 * before).toFixed(0)}% -> ${(100 * now).toFixed(0)}%` };
  }
  return { accepted: true, why: "accepted" };
}
