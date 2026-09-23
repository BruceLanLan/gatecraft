#!/usr/bin/env node
// One decision, end to end: fill its table, freeze it into a proven circuit, prove it again
// with Yosys, and run it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { drawAnchors } from "../src/anchors.mjs";
import { codebookPrompt, readBack, settleWidths } from "../src/draft.mjs";
import { runOpencode } from "../tools/chat-filler.mjs";
import { parseCount, run } from "../src/cli.mjs";
import { atThreshold, calibrateThreshold, checkAnchors, decide, fillDecision, freezeDecision, jevFiller, parseDecision } from "../src/decision.mjs";
import { budget, chatFiller, majorityFiller } from "../tools/chat-filler.mjs";
import { decisionFiles } from "../src/job.mjs";
import { decisionModule } from "../src/decisionexport.mjs";
import { proveWithYosys, yosysAvailable } from "../src/yosys.mjs";

const USAGE = `
Usage:
  node scripts/decide.mjs fill   --spec d.json [--with rule|jev|chat] [--asks-per-row N] [--out DIR] [--yes]
  node scripts/decide.mjs freeze --spec d.json [--anchors a.json] [--out DIR] [--steps S] [--seed S]
  node scripts/decide.mjs check  --out DIR
  node scripts/decide.mjs ask      --spec d.json --out DIR [--count 20]
  node scripts/decide.mjs calibrate --spec d.json --out DIR --anchors answered.json
  node scripts/decide.mjs export    --spec d.json --out DIR
  node scripts/decide.mjs run    --out DIR --given '{"gap_ahead":2,"on_ground":1,...}'

A decision (see examples/mario-jump.decision.json) names what is observed, with a phrase for
every legal code, and what can be done. The program that owns the decision buckets its raw
values into those codes; only the codes reach the circuit.

draft   turns one sentence into a codebook with a model, checks the shape with parseDecision,
        and reads it back in plain words with everything a person should look at before
        spending anything. Nothing is filled until you are happy with it.
review  reads an existing decision file back the same way, without a model.
fill    answers every legal situation and writes fill.json. --with rule uses the spec's own
        "rule" expression and asks no one. --with chat asks an ordinary chat model through the
        local opencode CLI - its confidence is self-reported, so calibrate it first with
        tools/calibrate.mjs. --with jev asks the typed decision model through
        Cloudflare Workers AI on your account (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN,
        or ~/.config/gatecraft/cloudflare.account and cloudflare.token); it prints the row
        count and an estimated cost first and refuses above 2,000 rows without --yes.
freeze  compiles fill.json (plus overrides.json when present) into a circuit proven on every
        row, and writes the codebook, the review list, the certificate and the Boolean IR.
check   runs the Yosys proof on the exported spec.blif and circuit.blif, if yosys is installed.
ask     asks YOU about twenty situations, one at a time, and writes anchors.answered.json.
        It never shows what the model answered - being told that turns your judgement into
        agreement with the machine. Answer several options when several are defensible, or
        press enter to skip one you would genuinely argue about. Stop whenever you like: it
        saves after every answer. This is the step that catches a decision the model gets
        confidently wrong; nothing else here does.
export  writes one dependency-free ES module you drop into your own program and call:
        import { decide } from "./d.decision.mjs". It embeds the proven table, not the
        netlist - the proof says they agree on every row and a lookup is faster. It REFUSES
        when calibration.json says do-not-delegate.
calibrate  answers the only question that is actually about YOUR decision: can this decision be
        delegated to the tool at all, and if so with the threshold set where. It needs anchors
        a person answered without seeing the model's answers - draw them with
        scripts/decide.mjs ask. Measured 2026-09-21: nothing else in this pipeline detects a
        decision the model gets confidently wrong, and a third of those measured were.
run     decides one situation from the frozen circuit.

Illegal codes and answers below the confidence threshold come back with review = 1: act on
the safe choice and look at review.json.
`;

const CONFIG = join(homedir(), ".config", "gatecraft");
const fileValue = (name) => {
  try { return readFileSync(join(CONFIG, name), "utf8").trim() || null; } catch { return null; }
};

run(USAGE, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { spec: { type: "string" }, out: { type: "string" }, count: { type: "string", default: "20" }, from: { type: "string" }, with: { type: "string", default: "rule" }, anchors: { type: "string" }, model: { type: "string", default: "opencode-go/deepseek-v4.1-flash" }, "max-calls": { type: "string" }, "asks-per-row": { type: "string", default: "1" }, steps: { type: "string" }, seed: { type: "string" }, given: { type: "string" }, yes: { type: "boolean" }, concurrency: { type: "string", default: "8" }, help: { type: "boolean", short: "h" } },
  });
  const command = positionals[0];
  if (!["draft", "review", "fill", "freeze", "check", "run", "calibrate", "export", "ask"].includes(command)) throw new Error("give one of: draft, review, fill, freeze, check, run, calibrate, export, ask (see --help)");

  const loadSpec = () => {
    if (!values.spec) throw new Error("give --spec FILE");
    const spec = JSON.parse(readFileSync(values.spec, "utf8"));
    return { spec, d: parseDecision(spec) };
  };

  if (command === "fill") {
    const { spec, d } = loadSpec();
    const out = values.out ?? join("out", d.name);
    const legal = 2 ** d.nIn - (() => { let n = 0; for (let r = 0; r < 2 ** d.nIn; r++) { let shift = 0; let ok = true; for (const f of d.fields) { if (!f.values.has((r >>> shift) & (2 ** f.width - 1))) ok = false; shift += f.width; } if (!ok) n++; } return n; })();
    let filler;
    if (values.with === "rule") {
      if (typeof spec.rule !== "string") throw new Error(`--with rule needs a "rule" expression in the spec`);
      filler = ruleFiller(d, spec.rule);
      console.log(`${d.name}: ${legal} legal situations of ${2 ** d.nIn}, answered by the spec's own rule`);
    } else if (values.with === "jev") {
      const apiKey = process.env.TYPESAFE_API_KEY?.trim() || fileValue("jev.token");
      const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || fileValue("cloudflare.account");
      const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || fileValue("cloudflare.token");
      if (!apiKey && !(account && token)) throw new Error(`no key for the decision model. One signup at https://typesafe.ai, then:\n  printf '%s' 'your-key' > ~/.config/gatecraft/jev.token && chmod 600 ~/.config/gatecraft/jev.token`);
      // Measured 2026-09-20: about 480 input tokens a situation at the listed $0.042 per million.
      const cost = legal * 480 / 1e6 * 0.042;
      console.log(`${d.name}: ${legal} legal situations of ${2 ** d.nIn} will be put to the decision model (${apiKey ? "typesafe.ai direct" : "via Cloudflare"}), about $${cost.toFixed(3)} at the listed price, on your account`);
      if (legal > 2000 && !values.yes) throw new Error(`${legal} situations is more than 2,000; pass --yes to spend that`);
      filler = jevFiller(d, { apiKey, account, token });
    } else if (values.with === "chat") {
      const repeat = parseCount(values["asks-per-row"], "--asks-per-row", { min: 1, max: 9 });
      const cap = values["max-calls"] ? parseCount(values["max-calls"], "--max-calls", { min: 1, max: 20000 }) : Math.ceil(legal * 1.5 * repeat);
      console.log(`${d.name}: ${legal} legal situations of ${2 ** d.nIn} will be put to ${values.model} through the local opencode CLI${repeat > 1 ? `, ${repeat} times each` : ""}, at most ${cap} calls`);
      console.log(`  its confidence is a number it writes itself, not a calibrated probability - see docs/findings.md`);
      if (repeat === 1) console.log(`  measured there: a single answer at or above the threshold reproduced on a re-ask only 14 times out of 20. --asks-per-row 3 takes the majority.`);
      if (legal > 2000 && !values.yes) throw new Error(`${legal} situations is more than 2,000; pass --yes to spend that`);
      const one = chatFiller(d, { model: values.model, cwd: mkdtempSync(join(tmpdir(), "gatecraft-fill-")), spend: budget(cap), source: "chat" });
      filler = repeat > 1 ? majorityFiller(one, repeat) : one;
    } else {
      throw new Error("--with must be rule, chat or jev");
    }
    let done = 0;
    const started = Date.now();
    const fill = await fillDecision(d, filler, { asksPerRow: values.with === "chat" ? parseCount(values["asks-per-row"], "--asks-per-row", { min: 1, max: 9 }) : null, concurrency: parseCount(values.concurrency, "--concurrency", { min: 1, max: 32 }), onRow: () => { done += 1; if (done % 100 === 0) console.log(`  ${done}/${legal}  ${((Date.now() - started) / 1000).toFixed(0)}s`); } });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "fill.json"), `${JSON.stringify(fill, null, 0)}\n`);
    const by = {};
    for (const r of fill.rows) by[r.source] = (by[r.source] ?? 0) + 1;
    const conf = fill.rows.filter((r) => r.confidence !== undefined).map((r) => r.confidence);
    const sure = conf.filter((c) => c >= d.threshold).length;
    console.log(`  ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(", ")}${conf.length ? `; ${sure} of ${conf.length} answers at or above the ${d.threshold} threshold, ${conf.length - sure} to review` : ""}`);
    console.log(`  -> ${join(out, "fill.json")}`);
    return;
  }

  if (command === "freeze") {
    const { spec, d } = loadSpec();
    const out = values.out ?? join("out", d.name);
    const fill = JSON.parse(readFileSync(join(out, "fill.json"), "utf8"));
    const overridesPath = join(out, "overrides.json");
    const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, "utf8")) : null;
    const anchorFile = values.anchors ? JSON.parse(readFileSync(values.anchors, "utf8")) : null;
    const frozen = freezeDecision(d, fill, { overrides, anchorFile, steps: values.steps === undefined ? undefined : parseCount(values.steps, "--steps", { min: 1, max: 1e9 }), seed: values.seed === undefined ? undefined : Number(values.seed) });
    const files = decisionFiles(frozen);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(out, file), text);
    // The bundle carries its own spec, so `run` and `check` need nothing outside the directory.
    writeFileSync(join(out, "decision.json"), `${JSON.stringify(spec, null, 2)}\n`);
    // Anchors are situations a person settled before any model was asked. Freezing a table
    // that contradicts one is allowed - the person may have changed their mind, and overrides
    // are how that is said - but it must never happen quietly. The check is recorded in the
    // bundle and shouted on the console.
    if (anchorFile) {
      const report = checkAnchors(d, frozen, anchorFile);
      writeFileSync(join(out, "anchors.json"), `${JSON.stringify(report, null, 1)}\n`);
      const acted = report.contradictedOnActedRows, reviewing = report.contradictedButReviewing;
      console.log(`  policy: ${report.checked - report.broken}/${report.checked} anchors held${report.unanswered ? `, ${report.unanswered} left unanswered` : ""}`);
      if (acted) console.log(`    ⚠ ${acted} CONTRADICTED on rows the circuit would act on. That is the kind that matters.`);
      if (reviewing) console.log(`    ${reviewing} contradicted on rows that review - the circuit hands those to a person and never acts on them, which is the mechanism working.`);
      for (const a of report.anchors.filter((x) => !x.held)) console.log(`    ! ${a.why ?? "anchor"}: allowed ${a.allow.join("/")}, the table says ${a.got}${a.reviewing ? " (but the row reviews)" : ""}`);
    } else {
      console.log(`  policy: NOT CHECKED AGAINST A PERSON. The proof below relates the circuit to the table and says nothing about whether the table is the policy you want.`);
      console.log(`    Two of six decisions measured this way were ones the model gets confidently wrong, and every other check here passed on both.`);
      console.log(`    node scripts/decide.mjs ask --spec <spec> --out ${out}`);
    }

    const c = frozen.certificate;
    const rows = c.decision.rows;
    console.log(`${d.name}: ${c.circuit.nand} NAND, depth ${c.circuit.depth}; ${c.verification.rowsChecked}/${c.verification.rowsChecked} rows exact`);
    const said = { rule: "the spec's rule", jev: "the decision model", filler: "a model", human: "a person" };
    const by = Object.entries(said).filter(([k]) => rows[k]).map(([k, label]) => `${label} ${rows[k]}`).join(", ") || "nobody";
    console.log(`  rows: ${rows.legal} legal + ${rows.illegal} illegal; answered by ${by}; failed ${rows.failed}; review ${rows.review}${overrides ? ` (overrides applied: ${overrides.rows?.length ?? 0})` : ""}`);
    console.log(`  codebook ${d.codebookSha256.slice(0, 16)}…  fill ${c.decision.fillSha256.slice(0, 16)}…`);
    console.log(`  -> ${out}/ (${Object.keys(files).length} files; review.json lists what a person should look at)`);
    return;
  }

  if (command === "calibrate") {
    // Every setting this tool has turned out to be a property of the decision rather than a
    // constant: how much gets settled, how permissive a majority may be, the safe threshold,
    // whether it can be calibrated at all, and which filling model matches the person. So
    // there is no global configuration to ship, only this, run once per decision.
    const { spec, d } = loadSpec();
    const out = values.out ?? join("out", d.name);
    const fill = JSON.parse(readFileSync(join(out, "fill.json"), "utf8"));
    if (fill.codebook !== d.codebookSha256) throw new Error("that fill was made against a different codebook");
    if (!values.anchors) throw new Error(`--anchors is required: this is the check nothing else performs.\n  node scripts/decide.mjs ask --spec <spec> --out ${out}`);
    const sheet = JSON.parse(readFileSync(values.anchors, "utf8"));
    const answered = (sheet.anchors ?? []).filter((a) => a.choice || a.allow?.length);
    if (answered.length < 5) throw new Error(`only ${answered.length} anchors are answered; five above a threshold is the least that says anything`);

    const report = { decision: d.name, codebook: d.codebookSha256, fill: join(out, "fill.json"), ...calibrateThreshold(d, fill, sheet, { rule: typeof spec.rule === "string" ? spec.rule : null }) };
    const { sweep, calibratedThreshold: bestT, rule, verdict, legal, anchorsAnswered } = report;
    const best = sweep.find((r) => r.threshold === bestT) ?? null;
    writeFileSync(join(out, "calibration.json"), `${JSON.stringify(report, null, 1)}\n`);

    console.log(`${d.name}: ${legal} legal situations, ${anchorsAnswered} anchors answered by a person\n`);
    console.log("  threshold   it decides        anchors above it   agree");
    for (const r of sweep) console.log(`  ${String(r.threshold).padStart(9)}   ${`${r.settled}/${legal} = ${(100 * r.settledShare).toFixed(0)}%`.padEnd(16)} ${String(r.anchorsAbove).padStart(16)}   ${r.held}/${r.anchorsAbove}${r.clean ? "   <- clean" : ""}`);
    console.log("");
    if (verdict === "do-not-delegate") {
      console.log(`  VERDICT: DO NOT DELEGATE THIS DECISION.`);
      console.log(`  At no threshold do the situations it would act on all agree with the person - it is`);
      console.log(`  wrong where it is most confident, which no proof, repeat or confidence score detects.`);
    } else if (verdict === "write-the-rule-instead") {
      console.log(`  VERDICT: WRITE THE RULE INSTEAD. Safe at ${best.threshold}, deciding ${(100 * best.settledShare).toFixed(0)}%,`);
      console.log(`  but the spec's own rule already matches ${rule.matched}/${rule.of} = ${(100 * rule.share).toFixed(0)}% of those rows. An if-statement is cheaper.`);
    } else {
      console.log(`  VERDICT: DELEGATE, with the threshold at ${best.threshold}.`);
      console.log(`  It decides ${best.settled}/${legal} = ${(100 * best.settledShare).toFixed(0)}% of the situations and hands the rest to a person,`);
      console.log(`  and every anchor above that threshold agrees with the person (${best.held}/${best.anchorsAbove}).`);
      if (rule) console.log(`  A written rule would get ${(100 * rule.share).toFixed(0)}% of those rows, which is why this is worth freezing.`);
    }
    console.log(`\n  -> ${join(out, "calibration.json")}`);
    return;
  }

  if (command === "export") {
    const { spec, d } = loadSpec();
    const out = values.out ?? join("out", d.name);
    const fill = JSON.parse(readFileSync(join(out, "fill.json"), "utf8"));
    const overridesPath = join(out, "overrides.json");
    const anchorsPath = join(out, "anchors.json");
    const calPath = join(out, "calibration.json");
    const calibration = existsSync(calPath) ? JSON.parse(readFileSync(calPath, "utf8")) : null;
    const frozen = freezeDecision(atThreshold(d, calibration), fill, {
      overrides: existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, "utf8")) : null,
      anchorFile: existsSync(anchorsPath) ? { anchors: JSON.parse(readFileSync(anchorsPath, "utf8")).anchors } : null,
      steps: values.steps === undefined ? undefined : parseCount(values.steps, "--steps", { min: 1, max: 1e9 }),
    });
    const text = decisionModule(frozen, { calibration });
    const file = join(out, `${d.name}.decision.mjs`);
    writeFileSync(file, text);
    console.log(`${d.name}: ${Math.round(text.length / 1024)} KB, no dependencies, no network`);
    if (!calibration) console.log(`  note: no calibration.json here, so nobody has established that this decision should be delegated at all. Run calibrate first.`);
    else console.log(`  calibrated ${JSON.stringify(calibration.verdict)} at threshold ${calibration.calibratedThreshold}, deciding ${(100 * (calibration.decides ?? 0)).toFixed(0)}%`);
    console.log(`  -> ${file}`);
    console.log(`\n  import { decide } from "./${d.name}.decision.mjs";`);
    console.log(`  const { action, review } = decide({ ${d.fields.map((f) => `${f.field}: 0`).join(", ")} });`);
    return;
  }

  if (command === "ask") {
    // The gate has to be easy or people route around it, and routing around it is the one
    // path measured to do harm. So: one question at a time, in the words the codebook uses,
    // with the model's answer never shown - being told it turns a judgement into agreement
    // with the machine. Saves after every answer so it can be abandoned halfway.
    const { d } = loadSpec();
    const out = values.out ?? join("out", d.name);
    const fill = JSON.parse(readFileSync(join(out, "fill.json"), "utf8"));
    if (fill.codebook !== d.codebookSha256) throw new Error("that fill was made against a different codebook");
    const path = join(out, "anchors.answered.json");
    const sheet = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : drawAnchors(d, fill, parseCount(values.count, "--count", { min: 1, max: 200 }), join(out, "fill.json"));
    const todo = sheet.anchors.filter((a) => a.choice === null && !a.allow);

    console.log(`${d.name}: ${sheet.anchors.length} situations drawn, ${todo.length} still to answer.\n`);
    console.log(d.question);
    d.choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.choice} - ${c.phrase}`));
    console.log(`\nType a number. Several numbers ("1 3") means more than one is defensible.`);
    console.log(`Press enter alone to skip one you would genuinely argue about. Ctrl-C stops; answers are saved as you go.\n`);

    // An async line iterator rather than rl.question(): with a pipe, question() swallows the
    // rest of the buffer after the first read, which made this untestable and "it works on a
    // real terminal, trust me" is not a verification.
    const rl = createInterface({ input: process.stdin, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    const askOne = async () => { process.stdout.write("> "); const { value, done } = await lines.next(); return done ? null : String(value); };
    let answered = 0;
    for (const [i, a] of sheet.anchors.entries()) {
      if (a.choice !== null || a.allow) continue;
      console.log(`--- ${i + 1}/${sheet.anchors.length} ---`);
      for (const [field, phrase] of Object.entries(a.situation)) console.log(`  ${field}: ${phrase}`);
      const raw = await askOne();
      if (raw === null) { console.log("\n  (input ended)"); break; }
      const reply = raw.trim();
      if (reply) {
        const picked = reply.split(/[\s,]+/).map((n) => d.choices[Number(n) - 1]?.choice).filter(Boolean);
        if (!picked.length) { console.log("  (not one of the numbers above - skipped)\n"); continue; }
        if (picked.length === 1) a.choice = picked[0]; else { a.allow = picked; delete a.choice; }
        answered += 1;
        writeFileSync(path, `${JSON.stringify(sheet, null, 1)}\n`);
      }
      console.log("");
    }
    rl.close();
    const done = sheet.anchors.filter((a) => a.choice || a.allow?.length).length;
    writeFileSync(path, `${JSON.stringify(sheet, null, 1)}\n`);
    console.log(`${answered} answered just now, ${done}/${sheet.anchors.length} in total -> ${path}`);
    console.log(done >= 5
      ? `\n  node scripts/decide.mjs calibrate --spec <spec> --out ${out} --anchors ${path}`
      : `\n  five answers is the least that says anything; run this again when you have a moment.`);
    return;
  }

  if (command === "review") {
    const { spec } = loadSpec();
    console.log(readBack(spec));
    return;
  }

  if (command === "draft") {
    // A model drafts, code judges the shape, and a person judges the buckets - which is the
    // only part that cannot be delegated, because a bucket the caller cannot actually compute
    // produces a circuit that will not wire to anything.
    if (!values.from) throw new Error(`--from "one sentence about the decision" is required`);
    const model = values.model ?? "opencode-go/glm-5.3";
    console.log(`asking ${model} to draft a codebook...\n`);
    let spec = null, why = "";
    for (let go = 0; go < 2 && !spec; go++) {
      const reply = await runOpencode(model, codebookPrompt(values.from) + (why ? `\n\nYour previous attempt was rejected: ${why}\nFix exactly that.` : ""), { cwd: mkdtempSync(join(tmpdir(), "gatecraft-draft-")), timeoutMs: 240_000 });
      const clean = reply.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
      const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
      try {
        const { spec: draft, fixed } = settleWidths(JSON.parse(clean.slice(a, b + 1)));
        parseDecision(draft);
        for (const f of fixed) console.log(`  widened ${f.field} from ${f.from} to ${f.to} bits: its own codes did not fit (arithmetic, not a judgement)`);
        spec = draft;
      }
      catch (error) { why = String(error.message).slice(0, 200); console.log(`  rejected: ${why}`); }
    }
    if (!spec) throw new Error("two drafts in a row were not a legal decision; write it by hand, or say the sentence differently");
    const out = values.out ?? join("out", spec.name);
    mkdirSync(out, { recursive: true });
    const file = join(out, `${spec.name}.decision.json`);
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
    console.log(readBack(spec));
    console.log(`\n  -> ${file}`);
    console.log(`\n  Read the buckets above. Every one has to be something your program can already work out.`);
    console.log(`  When it is right:  node scripts/decide.mjs fill --spec ${file} --with jev --out ${out}`);
    return;
  }

  if (command === "check") {
    if (!values.out) throw new Error("give --out DIR with spec.blif, circuit.blif and equiv.ys");
    const version = yosysAvailable();
    if (!version) throw new Error("yosys is not installed (brew install yosys); the files can be checked on any machine that has it");
    const files = Object.fromEntries(["spec.blif", "circuit.blif", "equiv.ys"].map((f) => [f, readFileSync(join(values.out, f), "utf8")]));
    const result = proveWithYosys(files);
    console.log(`${version}: ${result.proven ? "proven equal on every input" : "NOT proven"}`);
    if (!result.proven) { console.log(result.log.split("\n").slice(-12).join("\n")); process.exitCode = 2; }
    return;
  }

  if (command === "run") {
    if (!values.out || !values.given) throw new Error("give --out DIR and --given JSON");
    const spec = JSON.parse(readFileSync(values.spec ?? join(values.out, "decision.json"), "utf8"));
    const d = parseDecision(spec);
    const netlist = JSON.parse(readFileSync(join(values.out, "circuit.netlist.json"), "utf8"));
    const { decodeCircuit, hexToBytes } = await import("../src/netlist.mjs");
    const circuit = decodeCircuit(hexToBytes(netlist.netlistHex), netlist.nIn, netlist.nOut);
    const got = decide({ decision: d, circuit }, JSON.parse(values.given));
    console.log(JSON.stringify(got, null, 1));
  }
});
