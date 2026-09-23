// The last mile: one file you drop into your program and call.
//
// Everything upstream of this produces a circuit, a certificate and a verdict, and then leaves
// you at a command line. A program cannot use a command line. This writes a single ES module
// with no dependencies, no network and no server: import it, call decide() with the codes your
// program already has, get back the action and whether a person still has to look.
//
// What is embedded is the TABLE, not the netlist, and that is not a shortcut: the whole point
// of the proof is that the circuit equals this table on every row, checked exhaustively and
// then again by Yosys. Shipping the table ships the proven behaviour, and a lookup is faster
// than simulating gates. The hashes travel with it so any copy can be traced back to the
// bundle it came from.
//
// It refuses to export a decision whose calibration says do-not-delegate. Measured 2026-09-21:
// a third of the decisions put through a blind anchor check were ones the model gets
// confidently wrong while passing every other check here. Handing someone a callable for one
// of those would be the single most harmful thing this project could do.
import { decodeRow, isLegal } from "./decision.mjs";

export class ExportRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ExportRefused";
  }
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

export function decisionModule(frozen, { calibration = null, name } = {}) {
  const d = frozen.decision;
  if (calibration?.verdict === "do-not-delegate") {
    throw new ExportRefused(
      `${d.name}: calibration says do-not-delegate, so there is nothing safe to export. At no threshold do the situations this table would act on all agree with the person who answered its anchors - it is wrong where it is most confident, which no proof or confidence score detects. Fix the codebook, fill it differently, or leave this decision to people.`,
    );
  }
  // The table must be the one the calibration was about. Refusing here is the last line: every
  // exporter now freezes through atThreshold(), and this catches any path that forgets to.
  const chosen = calibration?.calibratedThreshold;
  if (typeof chosen === "number" && chosen !== d.threshold) {
    throw new ExportRefused(`${d.name}: this table was frozen at threshold ${d.threshold}, but the calibration chose ${chosen}. Freeze at the calibrated threshold (atThreshold) before exporting, or the module would act on rows the calibration excluded.`);
  }
  const mask = 2 ** d.actionBits - 1;
  const ys = frozen.table.ys;
  const bytes = new Uint8Array(ys.length);
  for (let i = 0; i < ys.length; i++) {
    const v = ys[i] >>> 0;
    if (v > 255) throw new ExportRefused(`${d.name}: an output row does not fit in a byte; this exporter handles up to 8 output bits`);
    bytes[i] = v;
  }
  const legalMask = new Uint8Array(ys.length);
  for (let row = 0; row < ys.length; row++) legalMask[row] = isLegal(d, decodeRow(d, row)) ? 1 : 0;

  const fields = d.fields.map((f) => ({ field: f.field, width: f.width, values: Object.fromEntries([...f.values].sort((a, b) => a[0] - b[0])) }));
  const choices = d.choices.map((c) => c.choice);
  const policy = frozen.certificate.decision.policy ?? { checkedAgainstAPerson: false };

  return `// ${name ?? d.name} - a decision frozen by gatecraft, proven on all ${ys.length} rows.
//
// Generated, do not edit. Drop it next to your code and call decide():
//
//   import { decide } from "./${name ?? d.name}.decision.mjs";
//   const { action, review } = decide({ ${d.fields.map((f) => f.field).join(", ")} });
//   if (review) hand_it_to_a_person(); else act_on(action);
//
// The numbers you pass are the codes your own program buckets its raw values into - the
// meaning of each one is in \`codebook\` below, in the words they were settled in. A code with
// no meaning listed is illegal: this answers ${JSON.stringify(d.safe)} and sets review, by
// construction rather than by anyone's judgement.
//
// What is guaranteed: this table is what was proven, row by row and then again by Yosys.
// What is NOT: that the table is the policy you want. ${policy.checkedAgainstAPerson
    ? `Here ${policy.held}/${policy.anchors} situations settled by a person in advance agree with it${policy.contradicted ? `, and ${policy.contradicted} do not - see anchors.json` : ""}.`
    : `NOBODY HAS CHECKED THAT. Two of six decisions measured this way turned out to be ones the model gets confidently wrong, and every other check passed on both.`}
${calibration ? `// Calibrated ${JSON.stringify(calibration.verdict)}${(calibration.confidenceValues ?? 2) <= 1 ? " - every row carries the same certainty, so no threshold applies" : ` with the confidence threshold at ${calibration.calibratedThreshold}`}; it decides ${(100 * (calibration.decides ?? 0)).toFixed(0)}% of situations and hands the rest over.\n` : ""}//
// codebook ${d.codebookSha256}
// fill     ${frozen.certificate.decision.fillSha256}

export const codebook = ${JSON.stringify({ name: d.name, sha256: d.codebookSha256, observe: fields, act: { choices, safe: d.safe }, review: "bit ${d.actionBits}" }, null, 1).replace(/^/gm, "")};

export const choices = ${JSON.stringify(choices)};
export const safe = ${JSON.stringify(d.safe)};
export const policy = ${JSON.stringify(policy)};

const TABLE = Uint8Array.from(atob("${b64(bytes)}"), (c) => c.charCodeAt(0));
const LEGAL = Uint8Array.from(atob("${b64(legalMask)}"), (c) => c.charCodeAt(0));
const WIDTHS = ${JSON.stringify(d.fields.map((f) => [f.field, f.width]))};

export function pack(codes) {
  let row = 0, shift = 0;
  for (const [field, width] of WIDTHS) {
    const c = codes[field];
    if (!Number.isInteger(c) || c < 0 || c >= 2 ** width) throw new TypeError(\`\${field} = \${JSON.stringify(c)} is not a \${width}-bit code\`);
    row |= c << shift;
    shift += width;
  }
  return row;
}

export function decide(codes) {
  const row = pack(codes);
  const y = TABLE[row];
  return { action: choices[y & ${mask}] ?? ${JSON.stringify(d.safe)}, review: Boolean((y >>> ${d.actionBits}) & 1), legal: Boolean(LEGAL[row]) };
}
`;
}
