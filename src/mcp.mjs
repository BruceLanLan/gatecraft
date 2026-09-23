// gatecraft as an MCP server: the decision line, as tools an agent can call.
//
// The person brings their own agent - Claude Code, Codex, whatever speaks MCP - and the agent
// is already a model, so it can draft a codebook, write a rule, or answer the situations
// itself. What it must NOT do is answer the twenty anchors: those are the only check that
// catches a decision a model gets confidently wrong, and a model answering them turns that
// check into one more consistency check. Every tool that touches anchors says so, and the
// calibration records who the caller says answered them.
//
// Work is kept in a directory, one per decision, under an output root the server is started
// with (default ./gatecraft-out). Tools pass that directory back and forth as `bundle` rather
// than shipping the fill through the agent's context: a 108-row fill is thousands of tokens the
// agent does not need, and keeping the model's answers out of the agent's view is also what
// stops it from showing them to the person it is about to survey. Nothing is written outside
// the output root.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { atThreshold, calibrateThreshold, decide as runDecision, decodeRow, encodeRow, fillDecision, freezeDecision, isLegal, jevFiller, parseDecision, phrasesOf, ruleFiller } from "./decision.mjs";
import { drawAnchors } from "./anchors.mjs";
import { readBack, reviewDraft, settleWidths } from "./draft.mjs";
import { decisionModule, ExportRefused } from "./decisionexport.mjs";
import { decisionFiles } from "./job.mjs";
import { proveWithYosys, yosysAvailable } from "./yosys.mjs";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_ROWS = 4096;

class ToolError extends Error {}

const SPEC = { type: "object", description: "The decision file: { name, scene?, question, observe: { field: { width, raw, values: { code: phrase } } }, act: { choices: { name: phrase }, safe }, threshold?, rule? }. A code with no phrase is illegal and reviews by construction." };
const BUNDLE = { type: "string", description: "The decision's working directory, exactly as an earlier gatecraft tool returned it." };
const CODES = { type: "object", additionalProperties: { type: "integer", minimum: 0 }, description: "One code per observed field, by field name - the codes the program buckets its raw values into." };

export const TOOLS = [
  {
    name: "gatecraft_decision_review",
    title: "Read a decision back",
    description: "Check a decision file and read it back in plain sentences, with the things a person must look at before anything is spent: buckets that look like they need free text, identity, the clock or the network (the wall this tool stops at), buckets that do not say where their value comes from, and the safe action, which a model drafting this tends to choose as the least surprising option instead of the least damaging. Bit widths too small for their own codes are widened and reported. Show the notes to the person; do not decide them yourself.",
    inputSchema: { type: "object", properties: { spec: SPEC }, required: ["spec"] },
  },
  {
    name: "gatecraft_decision_situations",
    title: "List the situations to answer",
    description: "Every legal situation of a decision, in the codebook's own words, so the agent can answer them itself and pass the answers to gatecraft_decision_fill with with=\"answers\". Paged: offset and limit.",
    inputSchema: { type: "object", properties: { spec: SPEC, offset: { type: "integer", minimum: 0, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 512, default: 128 } }, required: ["spec"] },
  },
  {
    name: "gatecraft_decision_fill",
    title: "Fill and freeze a decision",
    description: "Answer every legal situation, build the table, compile it to a NAND circuit and prove the circuit equals the table on every row (and again with Yosys when it is installed). with=\"rule\" uses an expression over the fields (the spec's own rule if none is given) - free and exact, but a decision you can write as a rule is one you should ship as an if-statement. with=\"answers\" takes the agent's own answers: [{ given: {field: code}, choice, confidence 0-1 }] for every situation from gatecraft_decision_situations; a missing row reviews. with=\"jev\" asks the typed decision model with the key on this machine. Returns the bundle directory the other tools take. The model's answers stay in the bundle; do not read them out to the person you are about to survey.",
    inputSchema: {
      type: "object",
      properties: {
        spec: SPEC,
        with: { type: "string", enum: ["rule", "answers", "jev"] },
        rule: { type: "string", description: "with=rule: an expression over the fields that names a choice, e.g. tone == 2 ? remove : keep" },
        answers: { type: "array", items: { type: "object", properties: { given: CODES, choice: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 } }, required: ["given", "choice"] } },
      },
      required: ["spec", "with"],
    },
  },
  {
    name: "gatecraft_decision_anchors",
    title: "Draw twenty questions for the person",
    description: "Draw situations, stratified across the fill's confidence, for THE PERSON to answer - not you. Put each one to the human user in the codebook's words, without saying what the model or you would answer, and record what they say: one choice, several when more than one is defensible, or nothing to skip. Two of six decisions measured this way were ones the model gets confidently wrong while passing every proof, repeat and confidence check; a model answering these cannot catch that.",
    inputSchema: { type: "object", properties: { bundle: BUNDLE, count: { type: "integer", minimum: 5, maximum: 100, default: 20 } }, required: ["bundle"] },
  },
  {
    name: "gatecraft_decision_calibrate",
    title: "Can this decision be delegated?",
    description: "Sweep the confidence threshold against the person's answers and give a verdict: delegate (with the threshold and how much it decides), write-the-rule-instead, or do-not-delegate - either because it contradicts the person where it would act, or because too few answers fall where it acts yet (answer more). answers: the sheet from gatecraft_decision_anchors with choice (or allow) filled in by the person. answered_by is recorded in the bundle; say honestly who answered.",
    inputSchema: {
      type: "object",
      properties: {
        bundle: BUNDLE,
        answers: { type: "array", items: { type: "object", properties: { given: CODES, choice: { type: ["string", "null"] }, allow: { type: "array", items: { type: "string" } } }, required: ["given"] } },
        answered_by: { type: "string", enum: ["person", "agent"], description: "Who chose these answers. Anchors answered by an agent are recorded as such and do not count as a check against a person." },
      },
      required: ["bundle", "answers", "answered_by"],
    },
  },
  {
    name: "gatecraft_decision_decide",
    title: "Run the frozen decision",
    description: "Run the proven circuit on one situation: returns the action, whether it hands the case to a person (review), and whether the codes were legal. An illegal code answers the safe action with review set, by construction.",
    inputSchema: { type: "object", properties: { bundle: BUNDLE, codes: CODES }, required: ["bundle", "codes"] },
  },
  {
    name: "gatecraft_decision_export",
    title: "Export the decision as one module",
    description: "Write a dependency-free ES module - import { decide } from it and call it with the codes your program already has - into the bundle, and return its path. Refused when calibration says do-not-delegate. Exporting before any calibration is allowed but the module says in its header that nobody has checked the table against a person.",
    inputSchema: { type: "object", properties: { bundle: BUNDLE }, required: ["bundle"] },
  },
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);

export function createGatecraftMcp({ outRoot = resolve("gatecraft-out"), key = () => null, fetch = globalThis.fetch, yosys = { available: yosysAvailable, prove: proveWithYosys } } = {}) {
  const root = resolve(outRoot);

  // A bundle is a directory the server made, under its root. Anything else is refused: the
  // agent hands paths back, and a path is exactly what a confused or steered agent gets wrong.
  const bundleDir = (given) => {
    if (typeof given !== "string" || !given) throw new ToolError("bundle is required: the directory an earlier gatecraft tool returned");
    const dir = resolve(root, given);
    const rel = relative(root, dir);
    if (!rel || rel.startsWith("..") || rel.split(sep).includes("..") || resolve(root, rel) !== dir) throw new ToolError(`bundle must be a directory under ${root}`);
    if (!existsSync(join(dir, "decision.json")) || !existsSync(join(dir, "fill.json"))) throw new ToolError(`${dir} is not a gatecraft decision bundle (no decision.json and fill.json)`);
    return dir;
  };
  const load = (dir) => {
    const spec = readJson(join(dir, "decision.json"));
    const d = parseDecision(spec);
    return { spec, d, fill: readJson(join(dir, "fill.json")) };
  };
  const settled = (spec) => {
    const { spec: fixed, fixed: widened } = settleWidths(spec);
    return { spec: fixed, widened, d: parseDecision(fixed) };
  };
  const legalRows = (d) => {
    const rows = [];
    for (let row = 0; row < 2 ** d.nIn; row++) if (isLegal(d, decodeRow(d, row))) rows.push(row);
    return rows;
  };

  const tools = {
    gatecraft_decision_review: ({ spec }) => {
      const { spec: fixed, widened, d } = settled(spec);
      const { legal, rows, notes } = reviewDraft(fixed);
      const text = [
        ...widened.map((w) => `note: "${w.field}" was widened from ${w.from} to ${w.to} bits - its own codes did not fit. Arithmetic, not a judgement.`),
        readBack(fixed),
      ].join("\n");
      return { text, data: { name: d.name, legal, rows, bits: d.nIn, notes, widened, spec: widened.length ? fixed : undefined } };
    },

    gatecraft_decision_situations: ({ spec, offset = 0, limit = 128 }) => {
      const { d } = settled(spec);
      const rows = legalRows(d);
      if (rows.length > MAX_ROWS) throw new ToolError(`${rows.length} legal situations is more than this server fills (${MAX_ROWS})`);
      const page = rows.slice(offset, offset + Math.min(limit, 512));
      const situations = page.map((row) => ({ given: decodeRow(d, row), situation: phrasesOf(d, decodeRow(d, row)) }));
      const choices = d.choices.map((c) => `${c.choice} = ${c.phrase}`).join("; ");
      return {
        text: `${d.name}: situations ${offset + 1}-${offset + page.length} of ${rows.length}. ${d.question} Choices: ${choices}. Answer each with { given, choice, confidence } and pass them all to gatecraft_decision_fill with with="answers".`,
        data: { total: rows.length, offset, situations, choices: d.choices.map((c) => ({ choice: c.choice, phrase: c.phrase })), question: d.question },
      };
    },

    gatecraft_decision_fill: async ({ spec, with: source, rule = null, answers = null }) => {
      const { spec: fixed, d } = settled(spec);
      const legal = legalRows(d).length;
      if (legal > MAX_ROWS) throw new ToolError(`${legal} legal situations is more than this server fills (${MAX_ROWS})`);
      let filler;
      if (source === "rule") {
        const expression = rule ?? fixed.rule;
        if (typeof expression !== "string" || !expression.trim()) throw new ToolError("with=rule needs a rule, or a spec that states one");
        filler = ruleFiller(d, expression);
      } else if (source === "answers") {
        if (!Array.isArray(answers) || !answers.length) throw new ToolError("with=answers needs answers: [{ given, choice, confidence }] for the situations from gatecraft_decision_situations");
        const by = new Map();
        for (const a of answers) {
          const row = encodeRow(d, a.given ?? {});
          by.set(row, { choice: a.choice, confidence: Number.isFinite(a.confidence) ? Math.min(1, Math.max(0, a.confidence)) : 0.5, source: "agent" });
        }
        filler = (codes) => {
          const answer = by.get(encodeRow(d, codes));
          if (!answer) throw new Error("no answer was given for this situation");
          return answer;
        };
      } else if (source === "jev") {
        const apiKey = key();
        if (!apiKey) throw new ToolError("no decision-model key on this machine: sign up once at typesafe.ai and write the key to ~/.config/gatecraft/jev.token, or fill with=rule / with=answers");
        filler = jevFiller(d, { apiKey, fetch });
      } else throw new ToolError(`with must be rule, answers or jev, not ${JSON.stringify(source)}`);

      const fill = await fillDecision(d, filler);
      const dir = join(root, d.name);
      mkdirSync(dir, { recursive: true });
      const frozen = freezeDecision(d, fill);
      for (const [file, text] of Object.entries(decisionFiles(frozen))) writeFileSync(join(dir, file), text);
      writeJson(join(dir, "decision.json"), fixed);
      let second = "not run: yosys is not installed (brew install yosys); spec.blif, circuit.blif and equiv.ys are in the bundle for any machine that has it";
      if (yosys.available()) {
        const files = Object.fromEntries(["spec.blif", "circuit.blif", "equiv.ys"].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
        second = yosys.prove(files).proven ? "proven equal on every input by Yosys" : "NOT PROVEN by Yosys - do not use this bundle";
      }
      const c = frozen.certificate;
      const rows = fill.rows.filter(Boolean);
      const answered = rows.filter((r) => r.choice).length;
      const failed = rows.filter((r) => r.source === "failed").length;
      const sure = rows.filter((r) => r.choice && (r.confidence ?? 1) >= d.threshold).length;
      const review = c.decision.rows.review;
      return {
        text: [
          `${d.name}: ${answered} of ${legal} situations answered (${source})${failed ? `, ${failed} failed and review` : ""}; ${sure} at or above the ${d.threshold} threshold.`,
          `Circuit: ${c.circuit.nand} NAND, proven equal to the table on all ${c.verification.rowsChecked} rows; second proof: ${second}. ${review} rows hand the case to a person.`,
          `The proof relates the circuit to the table and says nothing about whether the table is the policy the person wants. Next: gatecraft_decision_anchors, and put those questions to the person.`,
          `bundle: ${dir}`,
        ].join("\n"),
        data: { bundle: dir, legal, answered, failed, settled: sure, nand: c.circuit.nand, rowsChecked: c.verification.rowsChecked, review, yosys: second },
      };
    },

    gatecraft_decision_anchors: ({ bundle, count = 20 }) => {
      const dir = bundleDir(bundle);
      const { d, fill } = load(dir);
      const sheet = drawAnchors(d, fill, Math.min(Math.max(5, count), 100), dir);
      writeJson(join(dir, "anchors.sheet.json"), sheet);
      const lines = sheet.anchors.map((a, i) => `${i + 1}. ${Object.entries(a.situation).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
      return {
        text: [
          `Put these ${sheet.anchors.length} situations to the person, one at a time, in these words. Do not tell them what the model or you would answer, and do not answer them yourself.`,
          `Question: ${d.question}`,
          `Choices: ${d.choices.map((c) => `${c.choice} (${c.phrase})`).join(", ")}. They may pick several when more than one is defensible, or skip one they would genuinely argue about.`,
          ...lines,
          `Then call gatecraft_decision_calibrate with the sheet's anchors, each with choice or allow set from what the person said, and answered_by: "person".`,
        ].join("\n"),
        data: { bundle: dir, question: d.question, choices: d.choices.map((c) => ({ choice: c.choice, phrase: c.phrase })), anchors: sheet.anchors.map((a) => ({ given: a.given, situation: a.situation })) },
      };
    },

    gatecraft_decision_calibrate: ({ bundle, answers, answered_by: by }) => {
      const dir = bundleDir(bundle);
      const { d, fill } = load(dir);
      if (!Array.isArray(answers)) throw new ToolError("answers must be the anchors from gatecraft_decision_anchors with choice or allow filled in");
      if (by !== "person" && by !== "agent") throw new ToolError("answered_by must be person or agent - say who actually chose the answers");
      const sheet = { answeredBy: by, anchors: answers.map((a) => ({ given: a.given, ...(a.allow?.length ? { allow: a.allow } : { choice: a.choice ?? null }) })) };
      const spec = readJson(join(dir, "decision.json"));
      const cal = calibrateThreshold(d, fill, sheet, { rule: spec.rule ?? null });
      writeJson(join(dir, "anchors.json"), sheet);
      writeJson(join(dir, "calibration.json"), { ...cal, answeredBy: by });
      const line = cal.verdict === "delegate"
        ? `DELEGATE with the threshold at ${cal.calibratedThreshold}: it settles ${Math.round(100 * cal.decides)}% of situations and hands the rest to a person, and every situation it would act on agrees with the answers.`
        : cal.verdict === "write-the-rule-instead"
          ? `WRITE THE RULE INSTEAD: it is safe, but the stated rule already matches ${Math.round(100 * (cal.rule?.share ?? 0))}% of what it would decide. An if-statement is cheaper than a circuit.`
          : cal.why === "too-few"
            ? `NOT SETTLED YET: ${cal.agreesUpTo ? `where it acts it agrees (${cal.agreesUpTo.held}/${cal.agreesUpTo.anchorsAbove} at ${cal.agreesUpTo.threshold}), but` : "none of the answers fall where it acts, and"} ${cal.least} answers above a threshold is the least that counts. Ask the person more situations and calibrate again.`
            : "DO NOT DELEGATE: at no threshold do the situations it would act on all agree with the answers. It is wrong where it is most confident, which no proof, repeat or confidence score detects.";
      const sweep = (cal.confidenceValues ?? 2) <= 1 ? cal.sweep.slice(0, 1) : cal.sweep;
      return {
        text: [
          line,
          by === "agent" ? "These answers were given by an agent, not a person: this is a consistency check, not a check against anyone's judgement." : null,
          "threshold | decides | answers above | agree",
          ...sweep.map((r) => `${(cal.confidenceValues ?? 2) <= 1 ? "any" : r.threshold} | ${r.settled}/${cal.legal} | ${r.anchorsAbove} | ${r.held}/${r.anchorsAbove}`),
        ].filter(Boolean).join("\n"),
        data: { bundle: dir, verdict: cal.verdict, why: cal.why, threshold: cal.calibratedThreshold, decides: cal.decides, answeredBy: by, sweep: cal.sweep },
      };
    },

    gatecraft_decision_decide: ({ bundle, codes }) => {
      const dir = bundleDir(bundle);
      const { d, fill } = load(dir);
      const cal = existsSync(join(dir, "calibration.json")) ? readJson(join(dir, "calibration.json")) : null;
      const frozen = freezeDecision(atThreshold(d, cal), fill);
      const out = runDecision(frozen, codes ?? {});
      return { text: `${out.review ? "hand it to a person" : "act"}: ${out.action}${out.legal ? "" : " (illegal codes: the safe action, by construction)"}`, data: { action: out.action, review: Boolean(out.review), legal: out.legal, situation: out.situation } };
    },

    gatecraft_decision_export: ({ bundle }) => {
      const dir = bundleDir(bundle);
      const { d, fill } = load(dir);
      const cal = existsSync(join(dir, "calibration.json")) ? readJson(join(dir, "calibration.json")) : null;
      const anchors = existsSync(join(dir, "anchors.json")) ? readJson(join(dir, "anchors.json")) : null;
      const counted = anchors && cal?.answeredBy === "person" ? anchors : null;
      const frozen = freezeDecision(atThreshold(d, cal), fill, { anchorFile: counted });
      let text;
      try { text = decisionModule(frozen, { calibration: cal }); }
      catch (error) { if (error instanceof ExportRefused) throw new ToolError(error.message); throw error; }
      const file = join(dir, `${d.name}.decision.mjs`);
      writeFileSync(file, text);
      return {
        text: `${file}\nimport { decide } from it and call decide({ ${d.fields.map((f) => f.field).join(", ")} }) with your program's codes; it returns { action, review, legal }. ${counted ? "Checked against a person's answers." : "NOT checked against a person: the module's header says so."}`,
        data: { file, checkedAgainstAPerson: Boolean(counted), verdict: cal?.verdict ?? null },
      };
    },
  };

  async function callTool(name, args) {
    const tool = tools[name];
    if (!tool) return { content: [{ type: "text", text: `no tool named ${name}` }], isError: true };
    try {
      const { text, data } = await tool(args ?? {});
      return { content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) };
    } catch (error) {
      // A tool that fails tells the agent what to do next; a stack trace tells it nothing.
      return { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true };
    }
  }

  // One JSON-RPC message in, one out (or none for a notification).
  async function handle(message) {
    const { id, method, params } = message ?? {};
    const reply = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
    const fail = (code, text) => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message: text } });
    if (message?.jsonrpc !== "2.0" || typeof method !== "string") return fail(-32600, "not a JSON-RPC 2.0 request");
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "gatecraft", version: packageVersion() },
          instructions: "gatecraft freezes one small, repeated decision into a table proven on every row. Flow: gatecraft_decision_review (show the notes to the person) -> gatecraft_decision_fill -> gatecraft_decision_anchors (the PERSON answers these, not you) -> gatecraft_decision_calibrate -> gatecraft_decision_export. Observations must already be a few discrete codes; free text, identity, the clock and the network are outside what this does.",
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": return reply(await callTool(params?.name, params?.arguments));
      default:
        if (method.startsWith("notifications/")) return null;
        return fail(-32601, `method not found: ${method}`);
    }
  }

  return { handle, callTool, root };
}

let version = null;
function packageVersion() {
  if (version) return version;
  try { version = readJson(new URL("../package.json", import.meta.url)).version; } catch { version = "0.0.0"; }
  return version;
}
