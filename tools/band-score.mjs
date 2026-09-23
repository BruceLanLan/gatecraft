#!/usr/bin/env node
// The band: is there a decision that a short rule cannot capture AND a calibrated model can
// still settle most of?
//
//   node tools/band-score.mjs out/band
//
// Judged exactly as pre-registered (docs/method.md, "the band"), before any of this was filled:
//   - a rule is scored ONLY on the rows the model settled (confidence >= threshold). Scoring it
//     against the whole table would score it against rows the model itself has no answer for.
//   - the denominator is reported per decision and never averaged across them; under 10 settled
//     rows the decision is UNMEASURABLE and does not count either way.
//   - in the band = best rule <= 85% on settled rows AND the model settles >= 50% of legal rows.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeRow, isLegal, parseDecision, ruleFiller } from "../src/decision.mjs";

const dir = process.argv[2] ?? "out/band";
const rules = JSON.parse(readFileSync(join(dir, "rules.json"), "utf8"));
// Iterate the DECISIONS, not the rules file. A decision whose rules could not be drafted still
// fitted a codebook, so it has to appear as unmeasurable rather than vanish from the
// denominator - a decision that quietly disappears is how a rate gets flattering.
const names = readdirSync(dir).filter((f) => f.endsWith(".decision.json")).map((f) => f.replace(".decision.json", "")).sort();

console.log("decision".padEnd(28), "opts".padStart(5), "legal".padStart(6), "settled".padStart(14), "best rule on settled".padStart(22), "  in the band?");
const verdicts = [];
for (const name of names) {
  const d = parseDecision(JSON.parse(readFileSync(join(dir, `${name}.decision.json`), "utf8")));
  if (!rules[name]?.length || !existsSync(join(dir, name, "fill.json"))) {
    verdicts.push({ name, measurable: false, inBand: false, why: !rules[name]?.length ? "no rules were drafted for it" : "it was never filled" });
    console.log(name.padEnd(28), "".padStart(6), "".padStart(14), "".padStart(22), `  UNMEASURABLE - ${!rules[name]?.length ? "no rules drafted" : "never filled"}`);
    continue;
  }
  const fill = JSON.parse(readFileSync(join(dir, name, "fill.json"), "utf8"));
  if (fill.codebook !== d.codebookSha256) throw new Error(`${name}: fill is against a different codebook`);
  let legal = 0;
  for (let r = 0; r < 2 ** d.nIn; r++) if (isLegal(d, decodeRow(d, r))) legal += 1;
  const settled = fill.rows.filter((r) => r.choice && (r.confidence ?? 0) >= d.threshold);
  const scored = rules[name].map((expr) => {
    const says = ruleFiller(d, expr);
    const hit = settled.filter((r) => says(decodeRow(d, r.row)).choice === r.choice).length;
    return { expr, hit, share: settled.length ? hit / settled.length : null };
  });
  const best = scored.reduce((a, b) => (b.share > (a?.share ?? -1) ? b : a), null);
  const settledShare = legal ? settled.length / legal : 0;
  const measurable = settled.length >= 10;
  const inBand = measurable && best.share <= 0.85 && settledShare >= 0.5;
  verdicts.push({ name, options: d.choices.length, legal, settled: settled.length, settledShare, best, measurable, inBand });
  console.log(
    name.padEnd(28),
    String(d.choices.length).padStart(5),
    String(legal).padStart(6),
    `${settled.length}/${legal} = ${(100 * settledShare).toFixed(0)}%`.padStart(14),
    `${best.hit}/${settled.length} = ${(100 * best.share).toFixed(0)}%`.padStart(22),
    "  " + (!measurable ? `UNMEASURABLE (${settled.length} settled rows)` : inBand ? "YES" : best.share > 0.85 ? "no - a rule captures it" : "no - too little is settled"),
  );
}
const usable = verdicts.filter((v) => v.measurable);
const hits = usable.filter((v) => v.inBand);
console.log(`\n${hits.length}/${usable.length} measurable decisions land in the band (${verdicts.length - usable.length} unmeasurable)`);

// How many options a decision offers is a confounder for how much of it gets settled: a
// calibrated probability spread over four choices reaches 0.7 less often than one spread over
// two, whatever the decision is actually like. The drafting model went to four options almost
// every time, so this split is printed rather than left for someone to notice.
const byOptions = new Map();
for (const v of usable) {
  const g = byOptions.get(v.options) ?? { n: 0, band: 0, settled: 0 };
  g.n += 1; g.band += v.inBand ? 1 : 0; g.settled += v.settledShare;
  byOptions.set(v.options, g);
}
for (const [opts, g] of [...byOptions].sort()) console.log(`  ${opts} options: ${g.band}/${g.n} in the band, average settled ${(100 * g.settled / g.n).toFixed(0)}%`);
for (const v of verdicts.filter((x) => x.best)) console.log(`  ${v.name}: best rule was ${JSON.stringify(v.best.expr).slice(0, 96)}`);
for (const v of verdicts.filter((x) => !x.measurable)) console.log(`  ${v.name}: unmeasurable - ${v.why ?? "too few settled rows"}`);
