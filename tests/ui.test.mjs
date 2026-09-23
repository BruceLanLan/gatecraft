import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { artifactFiles, compileSpec } from "../src/job.mjs";
import { decodeCircuit, hexToBytes } from "../src/netlist.mjs";
import { sha256 } from "../src/sha256.mjs";
import { combinationalTable, fsmTable } from "../src/tables.mjs";
import { startUiServer } from "../src/ui-server.mjs";
import {
  EXAMPLES, KINDS, MAX_DRAWN_ELEMENTS, cliCommand, diagramLayout, exprEditorFrom, exprSpec, exprStatus, formatUnits, parseExampleLine,
  labelProblem, packFields, pinNames, resizeRows, specFileName, specFor, specText, stateGraph, unpackFields,
} from "../ui/model.mjs";
import { STRINGS } from "../ui/strings.mjs";
import { ROOT, runScript, tempDir } from "./helpers.mjs";

const example = (file) => JSON.parse(readFileSync(join(ROOT, "examples", file), "utf8"));

function editorFor(kind) {
  if (kind === "expr") return exprEditorFrom(example("thermostat.expr.json"));
  if (kind === "grid") return { map: example("grid-demo.map.json"), labels: ["stay", "left", "right", "jump"] };
  if (kind === "table") {
    const table = combinationalTable(example("majority3.table.json"));
    return { nIn: table.nIn, nOut: table.nOut, ys: [...table.ys] };
  }
  const table = fsmTable(example("counter.fsm.json"));
  return { nIn: table.nIn, nState: table.nState, nOut: table.nOut, ys: [...table.ys] };
}

function get(port, path, { method = "GET", host = `127.0.0.1:${port}` } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("SHA-256 in plain JavaScript matches node:crypto", () => {
  for (let n = 0; n < 200; n++) {
    const bytes = randomBytes(n);
    assert.equal(sha256(bytes), createHash("sha256").update(bytes).digest("hex"), `length ${n}`);
  }
  const big = randomBytes(70_001);
  assert.equal(sha256("head\n", big), createHash("sha256").update("head\n").update(big).digest("hex"));
});

test("everything the page loads is browser-safe and inside the served folders", () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) {
      assert.ok(spec.startsWith("."), `${relative(ROOT, file)} imports "${spec}", which a browser cannot load`);
      const target = resolve(dirname(file), spec);
      assert.ok(existsSync(target), `${relative(ROOT, file)} imports missing ${spec}`);
      assert.ok(["ui", "src"].includes(relative(ROOT, target).split(/[\\/]/)[0]), `${spec} is outside the served folders`);
      visit(target);
    }
  };
  visit(join(ROOT, "ui", "app.mjs"));
  visit(join(ROOT, "ui", "worker.mjs"));
  assert.ok(seen.has(join(ROOT, "src", "compile.mjs")) && seen.has(join(ROOT, "src", "tapeout.mjs")));
});

test("a compile in the page produces the command line's bytes from the downloaded spec", () => {
  for (const kind of KINDS) {
    const editor = editorFor(kind);
    const spec = specFor(kind, editor);
    const name = `ui-${kind}`;
    const labels = editor.labels;
    const objective = kind === "fsm" ? "cost" : undefined;
    const result = compileSpec(kind, spec, { labels, steps: 3000, objective });
    const files = artifactFiles(name, result);

    const dir = tempDir();
    writeFileSync(join(dir, specFileName(kind, name)), specText(kind, spec));
    const command = cliCommand(kind, { name, labels, seed: result.certificate.reproduce.seed, steps: result.certificate.reproduce.steps, objective });
    const [, script, ...args] = command.split(" ");
    const r = runScript(script, [...args, "--out", join(dir, "out")], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(join(dir, "out", file), "utf8"), text, `${kind}: ${file}`);
  }
});

test("spec files parse back to the spec they were written from", () => {
  for (const kind of KINDS) {
    const spec = specFor(kind, editorFor(kind));
    const parsed = JSON.parse(specText(kind, spec));
    assert.deepEqual(kind === "grid" ? { map: parsed } : parsed, spec);
  }
});

test("the expression editor round-trips its spec, checks it like the compiler, and packs named values", () => {
  const spec = example("thermostat.expr.json");
  const editor = exprEditorFrom(spec);
  assert.deepEqual(exprSpec(editor), spec);
  const status = exprStatus(editor, "zh");
  assert.deepEqual({ ok: status.ok, nIn: status.nIn, nOut: status.nOut, rows: status.rows, examplesHold: status.examplesHold }, { ok: true, nIn: 15, nOut: 8, rows: 32768, examplesHold: 4 });
  assert.equal(status.explain.lines[5], "heat（1 位）= cold 或者（heating 并且 不是 warm）");
  assert.equal(editor.examples[0].text, "temp=18 target=22 heating=0 -> heat=1 error=4");

  // example lines: typed loosely, checked one by one, a wrong one blocks the program
  assert.deepEqual(parseExampleLine("temp=1，target=2 heating:0 → heat=1"), { given: { temp: 1, target: 2, heating: 0 }, expect: { heat: 1 } });
  assert.throws(() => parseExampleLine("temp=1 heat=1"), /one arrow/);
  assert.throws(() => parseExampleLine("temp=x -> heat=1"), /name=number/);
  editor.examples.push({ text: "" }, { text: "temp=30 target=22 heating=0 -> heat=1" });
  const wrong = exprStatus(editor);
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.examples.map((e) => e && e.ok), [true, true, true, true, null, false]);
  assert.match(wrong.examples[5].message, /example 5: given temp=30 target=22 heating=0, expected heat=1 but the program gives heat=0/);
  editor.examples.splice(4, 2);

  // memory: rows round-trip, and "then" gives the state after the tick
  const counter = example("counter.expr.json");
  const counterEditor = exprEditorFrom(counter);
  assert.deepEqual(exprSpec(counterEditor), counter);
  assert.equal(counterEditor.examples[2].text, "press=1 count=9 -> digit=9 nine=1 then count=0");
  assert.deepEqual(parseExampleLine("press=1 count=3 -> 然后 count=4"), { given: { press: 1, count: 3 }, expect: {}, then: { count: 4 } });
  const counterStatus = exprStatus(counterEditor, "en");
  assert.deepEqual([counterStatus.ok, counterStatus.nState, counterStatus.rows, counterStatus.examplesHold], [true, 4, 32, 3]);
  counterEditor.examples.push({ text: "press=1 count=4 -> then count=6" });
  assert.match(exprStatus(counterEditor).examples[3].message, /expected next count=6 but the program gives next count=5/);

  // blank rows are ignored, duplicates and bad expressions are reported, not thrown
  editor.lets.push({ name: "  ", expr: "" });
  assert.deepEqual(exprSpec(editor), spec);
  editor.outputs.push({ name: "cold", width: 1, expr: "1" });
  assert.match(exprStatus(editor).message, /"cold" is used twice/);
  editor.outputs.pop();
  editor.outputs[0].expr = "cold ||";
  assert.equal(exprStatus(editor).ok, false);
  assert.equal(exprStatus({ inputs: [{ name: "a", width: 21 }], lets: [], outputs: [{ name: "y", width: 1, expr: "a" }] }).ok, false);
  assert.deepEqual(exprSpec({ inputs: [{ name: "a", width: 2 }], lets: [], outputs: [{ name: "y", width: 2, expr: "a" }] }), { inputs: { a: 2 }, outputs: { y: { width: 2, expr: "a" } } });

  // packing matches the compiler's table: temp in bits 0-6, target in 7-13, heating in 14
  const fields = [{ width: 7 }, { width: 7 }, { width: 1 }];
  const row = packFields(fields, [20, 30, 1]);
  assert.equal(row, 20 + 30 * 128 + 16384);
  assert.deepEqual(unpackFields(fields, row), [20, 30, 1]);
  const { table, certificate } = compileSpec("expr", spec, { steps: 1 });
  const [heat, error] = unpackFields(certificate.expression.outputs, table.ys[row]);
  assert.deepEqual([heat, error], [1, 10]);
});

test("resizing a table keeps the rows and bits that still exist", () => {
  const counter = editorFor("fsm");
  const wider = resizeRows(counter, { ...counter, nIn: 2 });
  for (let s = 0; s < 4; s++) for (let x = 0; x < 2; x++) assert.equal(wider[x + s * 4], counter.ys[x + s * 2]);
  assert.equal(wider.length, 16);
  const narrower = resizeRows(counter, { ...counter, nState: 1 });
  assert.deepEqual(narrower, counter.ys.slice(0, 4).map((v) => (v % 2) + (Math.floor(v / 2) % 2) * 2));
  const majority = editorFor("table");
  assert.deepEqual(resizeRows(majority, { ...majority, nOut: 2 }), majority.ys);
});

test("state graphs group transitions and know what is reachable", () => {
  const graph = stateGraph({ nIn: 1, nState: 2, nOut: 1, ys: [...fsmTable({ nIn: 1, nState: 2, nOut: 1, fn: "[0, x ? 1 : s]" }).ys] });
  assert.deepEqual([...graph.reachable].sort(), [0, 1]);
  assert.deepEqual(graph.edges.find((e) => e.from === 0 && e.to === 1).cases, [{ x: 1, y: 0 }]);
  assert.equal(graph.edges.reduce((n, e) => n + e.cases.length, 0), 8);
});

test("the circuit diagram draws every element once, wires left to right, latches fed back", () => {
  const { circuit } = compileSpec("fsm", specFor("fsm", editorFor("fsm")), { steps: 3000 });
  const decoded = decodeCircuit(hexToBytes(circuit.netlistHex), circuit.nIn, circuit.nOut);
  const layout = diagramLayout(decoded);
  const kinds = (k) => layout.nodes.filter((n) => n.kind === k).length;
  assert.equal(kinds("nand"), decoded.nNand);
  assert.equal(kinds("latch"), decoded.nLatch);
  assert.equal(kinds("input"), decoded.nIn);
  assert.equal(kinds("output"), decoded.nOut);
  assert.equal(layout.edges.length, 2 * decoded.nNand + decoded.nLatch + decoded.nOut);
  assert.equal(layout.edges.filter((e) => e.feedback).length, decoded.nLatch);
  for (const e of layout.edges.filter((w) => !w.feedback)) assert.ok(e.x1 < e.x2, "forward wires run left to right");
  for (const n of layout.nodes) assert.ok(n.x >= 0 && n.x <= layout.width && n.y >= 0 && n.y <= layout.height);
  const huge = { nIn: 1, nOut: 1, outputs: [3], elements: Array.from({ length: MAX_DRAWN_ELEMENTS + 1 }, (_, i) => ({ op: 0, a: 2, b: 2, out: 3 + i })) };
  assert.equal(diagramLayout(huge), null);
});

test("small formatting and validation helpers", () => {
  assert.equal(formatUnits(0n), "0");
  assert.equal(formatUnits("1500000000000000"), "0.0015");
  assert.equal(formatUnits(3n * 10n ** 18n), "3");
  assert.equal(labelProblem(["a", "b", "c", "d"]), null);
  assert.equal(labelProblem(["a", "", "c", "d"]), "labelEmpty");
  assert.equal(labelProblem(["a", "b,c", "c", "d"]), "labelComma");
  assert.equal(labelProblem(["a", "a", "c", "d"]), "labelDuplicate");
  assert.match(cliCommand("grid", { name: "g", labels: ["go", "it's", "x", "y"], seed: 1, steps: 2 }), /--labels 'go,it'\\''s,x,y'/);
  for (const kind of KINDS) for (const ex of EXAMPLES[kind]) assert.ok(existsSync(join(ROOT, "examples", ex.file)), ex.file);
});

test("both languages carry every string the page asks for", () => {
  assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort());
  const app = readFileSync(join(ROOT, "ui", "app.mjs"), "utf8");
  const html = readFileSync(join(ROOT, "ui", "index.html"), "utf8");
  const keys = new Set([
    ...[...app.matchAll(/\bt\("([A-Za-z_]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n="([A-Za-z_]+)"/g)].map((m) => m[1]),
    ...KINDS.flatMap((k) => [`kind_${k}`, `hint_${k}`, `fn_${k}`]),
    ...["synthesis", "annealing", "verification"].map((p) => `phase_${p}`),
    "labelEmpty", "labelComma", "labelDuplicate", "objective_gates", "objective_cost",
  ]);
  for (const key of keys) assert.ok(key in STRINGS.en, `missing string ${key}`);
});

test("the UI server hands out the page and nothing else", async () => {
  const server = await startUiServer({ port: 0 });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const { port } = server;
    const root = await get(port, "/");
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, "/ui/");
    const page = await get(port, "/ui/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.match(page.headers["content-security-policy"], /default-src 'self'/);
    assert.match(page.body, /app\.mjs/);
    assert.match((await get(port, "/ui/app.mjs")).headers["content-type"], /^text\/javascript/);
    assert.equal((await get(port, "/src/compile.mjs")).status, 200);
    assert.equal((await get(port, "/examples/counter.fsm.json")).status, 200);
    for (const path of ["/package.json", "/tools/setup.mjs", "/tests/helpers.mjs", "/ui/../package.json", "/ui/%2e%2e/package.json", "/src/..%2f..%2fpackage.json", "/.git/config", "/src/.hidden.mjs", "/ui/nope.mjs", "/src"]) {
      assert.equal((await get(port, path)).status, 404, path);
    }
    assert.equal((await get(port, "/ui/", { method: "POST" })).status, 405);
    assert.equal((await get(port, "/ui/", { host: `attacker.example:${port}` })).status, 403);
  } finally {
    await server.close();
  }
});

test("npm run ui prints the address it serves", async () => {
  const child = spawn(process.execPath, [join(ROOT, "scripts", "ui.mjs"), "--port", "0"], { cwd: ROOT });
  try {
    const url = await new Promise((done, fail) => {
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const match = out.match(/gatecraft UI: (http:\/\/127\.0\.0\.1:(\d+)\/)/);
        if (match) done(match);
      });
      child.on("exit", (code) => fail(new Error(`ui exited with ${code}`)));
    });
    assert.equal((await get(Number(url[2]), "/ui/")).status, 200);
  } finally {
    child.kill();
  }
});

test("no UI file hardcodes a contract address", () => {
  for (const file of readdirSync(join(ROOT, "ui"))) {
    const text = readFileSync(join(ROOT, "ui", file), "utf8");
    assert.equal(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.test(text), false, `ui/${file} contains a 20-byte address literal`);
  }
});

test("the sentence flow: every ready-made sentence has a program whose examples hold, in both languages", () => {
  for (const ex of EXAMPLES.flow) {
    assert.ok(ex.sentence.en && ex.sentence.zh, ex.id);
    assert.ok(STRINGS.en[`flowHint_${ex.id}`] && STRINGS.zh[`flowHint_${ex.id}`], `hint for ${ex.id}`);
    const spec = example(ex.file);
    const { certificate } = compileSpec("expr", spec, { steps: 2000 });
    assert.equal(certificate.verification.wrong, 0, ex.id);
    assert.ok(certificate.expression.examplesHold >= 3, `${ex.id} carries its own examples`);
  }
  for (const key of ["flowStep_say", "flowStep_understand", "flowStep_proof", "flowStep_try"]) assert.ok(STRINGS.zh[key] && STRINGS.en[key], key);
  for (const file of ["circuit.netlist.json", "circuit.certificate.json", "table.json"]) assert.ok(STRINGS.en[`file_${file.replace(/\W/g, "_")}`], file);
});

test("diagram pins are named after the program, short enough to fit their boxes", () => {
  const names = pinNames({
    inputs: [{ name: "press", width: 1 }, { name: "a", width: 12 }],
    state: [{ name: "count", width: 4 }],
    outputs: [{ name: "nine", width: 1 }],
  });
  assert.deepEqual(names.x.slice(0, 3), ["pres", "a0", "a1"]);
  assert.equal(names.x[11], "a10");
  assert.deepEqual(names.s, ["cou0", "cou1", "cou2", "cou3"]);
  assert.deepEqual(names.y, ["nine"]);
  for (const label of [...names.x, ...names.s, ...names.y]) assert.ok(label.length <= 4, label);
  assert.deepEqual(pinNames({ inputs: [{ name: "a", width: 1 }], outputs: [{ name: "y", width: 1 }] }).s, []);
});

test("the answer to the gate's one question becomes part of the sentence", async () => {
  const { gateAnswerSentence } = await import("../ui/model.mjs");
  assert.equal(
    gateAnswerSentence("温度太高就报警", "输入「温度」从几到几？", " 0 到 60 "),
    "温度太高就报警（输入「温度」从几到几：0 到 60）",
    "the question mark goes, the answer is folded in where the person can read and edit it",
  );
  assert.equal(gateAnswerSentence("一个灯", "", "按一下"), "一个灯（按一下）");
  assert.equal(gateAnswerSentence("一个灯", "从几到几？", "   "), "一个灯", "an empty answer changes nothing");
});
