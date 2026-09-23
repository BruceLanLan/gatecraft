#!/usr/bin/env node
// How a majority of N asks should be turned into one confidence, scored on data already paid
// for.
//
//   node tools/score-rules.mjs a.json b.json
//
// Two independent passes of tools/calibrate.mjs over the same rows, each keeping every
// individual ask. That is enough to ask, for any scoring rule, the only question that decides
// a bundle's worth: of the rows this rule would mark ACTIONABLE, how many give the same choice
// when the whole measurement runs again? No new calls.
//
// The rule in use today is mean(all asks) x (winner's share). A hint from a smaller look
// suggested the model's self-reported number might be discarding rows without buying much:
// unanimity alone kept 28 of 48 rows where the current rule kept 12. This checks that
// properly, symmetrically, on both passes.
//
// PRE-REGISTERED before running (2026-09-20), and it matters because sweeping six rules over
// one decision's 60 rows is an excellent way to fool yourself:
//   - a rule only counts as better if it keeps STRICTLY MORE actionable rows AND reproduces at
//     least as often as the rule in use, with both at or above the 90% bar.
//   - a winner found here is a HYPOTHESIS, not a new default. To become the default it has to
//     hold on a second decision that was not used to pick it.
import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2).map((p) => ({ path: p, ...JSON.parse(readFileSync(p, "utf8")) }));
if (!a || !b) { console.error("give two calibrate --json reports taken with --asks-per-row > 1"); process.exit(2); }
if (a.codebookSha256 !== b.codebookSha256) throw new Error("the two passes are against different codebooks");

const t = a.threshold;
const tally = (asks) => {
  const votes = new Map();
  for (const x of asks) votes.set(x.choice, (votes.get(x.choice) ?? 0) + 1);
  const [choice, won] = [...votes].sort((x, y) => y[1] - x[1])[0];
  return { choice, won, n: asks.length, mean: asks.reduce((s, x) => s + x.confidence, 0) / asks.length,
    winnerMean: asks.filter((x) => x.choice === choice).reduce((s, x) => s + x.confidence, 0) / won,
    min: Math.min(...asks.map((x) => x.confidence)) };
};

// Each rule answers one question: given the asks for a row, is this row actionable?
const RULES = {
  "in use: mean(all) x won/n >= 0.7": (v) => v.mean * (v.won / v.n) >= t,
  "unanimous only": (v) => v.won === v.n,
  "unanimous AND mean >= 0.7": (v) => v.won === v.n && v.mean >= t,
  "mean(winners) x won/n >= 0.7": (v) => v.winnerMean * (v.won / v.n) >= t,
  "every ask >= 0.7": (v) => v.min >= t,
  "majority only (>= 2 of 3)": (v) => v.won * 2 > v.n,
};

const rows = a.rows.filter((r) => r.asks);
const other = new Map(b.rows.filter((r) => r.asks).map((r) => [r.row, r]));
const both = rows.filter((r) => other.has(r.row));
if (!both.length) { console.error("these passes have no per-ask records; re-run calibrate with --asks-per-row 3"); process.exit(2); }

console.log(`${a.decision}: ${both.length} rows with per-ask records in both passes, ${a.asksPerRow} asks each\n`);
console.log("rule".padEnd(34), "actionable".padStart(11), "reproduce".padStart(12), "  also actionable in pass 2");
const results = [];
for (const [name, mark] of Object.entries(RULES)) {
  const chosen = both.filter((r) => mark(tally(r.asks)));
  const held = chosen.filter((r) => tally(r.asks).choice === tally(other.get(r.row).asks).choice).length;
  const stillMarked = chosen.filter((r) => mark(tally(other.get(r.row).asks))).length;
  const share = chosen.length ? held / chosen.length : null;
  results.push({ name, kept: chosen.length, of: both.length, held, share, stillMarked });
  console.log(name.padEnd(34), `${chosen.length}/${both.length}`.padStart(11), `${held}/${chosen.length}`.padStart(12),
    `  ${stillMarked}/${chosen.length}`, share !== null && share < 0.9 ? " BELOW THE BAR" : "");
}

const base = results[0];
const better = results.slice(1).filter((r) => r.kept > base.kept && r.share !== null && r.share >= Math.max(0.9, base.share ?? 0));
console.log(`\nin use keeps ${base.kept} at ${base.share === null ? "-" : `${(100 * base.share).toFixed(0)}%`}`);
console.log(better.length
  ? `HYPOTHESIS: ${better.map((r) => `"${r.name}" keeps ${r.kept} at ${(100 * r.share).toFixed(0)}%`).join("; ")}\n  -> not a new default until it holds on a decision that was not used to find it`
  : "no rule keeps strictly more rows without giving up reproducibility; the rule in use stands");
