// The file a caller drops into their own program: it has to behave exactly like the circuit
// that was proven, and it must not exist at all for a decision nobody should delegate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { atThreshold, decodeRow, encodeRow, fillDecision, freezeDecision, isLegal, parseDecision, ruleFiller } from "../src/decision.mjs";
import { ExportRefused, decisionModule } from "../src/decisionexport.mjs";
import { evaluateTable } from "../src/verify.mjs";

const spec = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));

async function frozenCharger(anchorFile = null) {
  const d = parseDecision(spec);
  const fill = await fillDecision(d, ruleFiller(d, spec.rule));
  return { d, frozen: freezeDecision(d, fill, { steps: 400, anchorFile }) };
}

test("the exported module answers every row exactly as the simulated gates do", async () => {
  const { d, frozen } = await frozenCharger();
  const text = decisionModule(frozen);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
  const ys = evaluateTable(frozen.circuit);
  const mask = 2 ** d.actionBits - 1;
  let wrong = 0;
  for (let row = 0; row < ys.length; row++) {
    const codes = decodeRow(d, row);
    const got = mod.decide(codes);
    const want = ys[row] >>> 0;
    if (got.action !== (d.choices[want & mask]?.choice ?? d.safe)) wrong += 1;
    else if (got.review !== Boolean((want >>> d.actionBits) & 1)) wrong += 1;
    else if (got.legal !== isLegal(d, codes)) wrong += 1;
  }
  assert.equal(wrong, 0, `${wrong} of ${ys.length} rows differ from the gates`);
  assert.equal(mod.codebook.sha256, d.codebookSha256);
  assert.equal(mod.safe, "stop");
  assert.throws(() => mod.decide({ temp: 9, soc: 0, cable: 0, cycles: 0, swelling: 0 }), /not a 2-bit code/);
});

test("a decision calibrated do-not-delegate cannot be exported at all", async () => {
  const { frozen } = await frozenCharger();
  assert.throws(
    () => decisionModule(frozen, { calibration: { verdict: "do-not-delegate", calibratedThreshold: null } }),
    (e) => e instanceof ExportRefused && /nothing safe to export/.test(e.message),
  );
  // The other two verdicts export, and the module carries which one it was.
  for (const verdict of ["delegate", "write-the-rule-instead"]) {
    const text = decisionModule(frozen, { calibration: { verdict, calibratedThreshold: frozen.decision.threshold, decides: 0.62 } });
    assert.match(text, new RegExp(`Calibrated "${verdict}"`));
  }
  // A fill with one certainty has no threshold to speak of, and the header says so rather than
  // naming whichever rung the sweep happened to stop on.
  const flat = decisionModule(frozen, { calibration: { verdict: "write-the-rule-instead", calibratedThreshold: frozen.decision.threshold, decides: 1, confidenceValues: 1 } });
  assert.match(flat, /no threshold applies/);
  assert.doesNotMatch(flat, /confidence threshold at/);
});

// The bug this guards: every exporter froze at the spec's threshold and then printed the
// calibrated one in the header. Calibrate to 0.8 because the person disagreed at 0.7, and the
// module still ACTED on a row the model was 0.75 sure of - one the calibration had excluded.
test("the exported module decides at the calibrated threshold, and refuses a table frozen at another", async () => {
  const d = parseDecision(spec);
  const says = ruleFiller(d, spec.rule);
  const probe = { temp: 1, soc: 1, cable: 1, cycles: 0, swelling: 0 };
  const probeRow = encodeRow(d, probe);
  const fill = await fillDecision(d, (codes) => ({ ...says(codes), confidence: encodeRow(d, codes) === probeRow ? 0.75 : 0.95, source: "jev" }));
  const calibration = { verdict: "delegate", calibratedThreshold: 0.8, decides: 0.9 };
  assert.equal(d.threshold, 0.7, "the spec's own threshold, below the probe's 0.75");

  // Frozen at the spec's 0.7, the probe row would be acted on. Exporting that under a 0.8
  // calibration is refused rather than shipped with a header that lies.
  const atSpec = freezeDecision(d, fill, { steps: 400 });
  assert.throws(() => decisionModule(atSpec, { calibration }), (e) => e instanceof ExportRefused && /frozen at threshold 0\.7, but the calibration chose 0\.8/.test(e.message));

  // Frozen through atThreshold, the same row hands itself to a person.
  const tuned = freezeDecision(atThreshold(d, calibration), fill, { steps: 400 });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(decisionModule(tuned, { calibration })).toString("base64")}`);
  assert.equal(mod.decide(probe).review, true, "0.75 is below the calibrated 0.8, so it reviews");
  assert.equal(atThreshold(d, null), d, "no calibration, no change");
});

test("the module says plainly when nobody has checked the table against a person", async () => {
  const unchecked = decisionModule((await frozenCharger()).frozen);
  assert.match(unchecked, /NOBODY HAS CHECKED THAT/);
  const anchors = { anchors: [{ given: { temp: 3, soc: 0, cable: 1, cycles: 0, swelling: 1 }, choice: "stop" }] };
  const checked = decisionModule((await frozenCharger(anchors)).frozen);
  assert.doesNotMatch(checked, /NOBODY HAS CHECKED THAT/);
  assert.match(checked, /1\/1 situations settled by a person/);
});
