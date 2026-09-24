// gatecraft as an MCP server, driven the way an agent drives it: a real process on stdio,
// newline-delimited JSON-RPC, the whole decision line from review to an importable module.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGatecraftMcp } from "../src/mcp.mjs";
import { decodeRow, isLegal, parseDecision, ruleFiller } from "../src/decision.mjs";

const spec = JSON.parse(readFileSync(new URL("../examples/charge-throttle.decision.json", import.meta.url), "utf8"));
const noYosys = { available: () => null, prove: () => ({ proven: false }) };

function server(out) {
  const child = spawn(process.execPath, [new URL("../scripts/mcp.mjs", import.meta.url).pathname, "--out", out], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TYPESAFE_API_KEY: "", GATECRAFT_TRIAL: "off" } });
  let buffer = "";
  const waiting = new Map();
  const stray = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const message = JSON.parse(line); // anything on stdout that is not JSON fails the test here
      if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } else stray.push(message);
    }
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`); });
  const call = async (name, args) => (await request("tools/call", { name, arguments: args })).result;
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const close = () => new Promise((resolve) => { child.on("exit", resolve); child.stdin.end(); });
  return { request, call, notify, close, stray };
}

test("an agent can take a decision from review to an importable module over stdio", async () => {
  const out = mkdtempSync(join(tmpdir(), "gatecraft-mcp-"));
  const s = server(out);
  try {
    const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "gatecraft");
    assert.match(init.result.instructions, /PERSON answers these, not you/);
    s.notify("notifications/initialized");

    const listed = (await s.request("tools/list", {})).result.tools;
    assert.deepEqual(listed.map((t) => t.name), ["gatecraft_decision_guide", "gatecraft_decision_review", "gatecraft_decision_situations", "gatecraft_decision_fill", "gatecraft_decision_anchors", "gatecraft_decision_calibrate", "gatecraft_decision_decide", "gatecraft_decision_export"]);
    for (const t of listed) assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);

    const review = await s.call("gatecraft_decision_review", { spec });
    assert.ok(!review.isError);
    assert.match(review.content[0].text, /charge-throttle: 8 bits, 192 legal situations of 256/);

    const filled = await s.call("gatecraft_decision_fill", { spec, with: "rule" });
    assert.ok(!filled.isError, filled.content[0].text);
    const bundle = filled.structuredContent.bundle;
    assert.equal(filled.structuredContent.answered, 192);
    assert.ok(bundle.startsWith(out));
    assert.ok(existsSync(join(bundle, "circuit.netlist.json")));

    // The sheet for the person carries situations and never the model's answers.
    const anchors = await s.call("gatecraft_decision_anchors", { bundle });
    assert.match(anchors.content[0].text, /do not answer them yourself/);
    for (const a of anchors.structuredContent.anchors) assert.deepEqual(Object.keys(a).sort(), ["given", "situation"], "no choice, no confidence");
    assert.doesNotMatch(anchors.content[0].text, /confidence|0\.\d\d/);

    // Answers agreeing with the rule: safe, and the verdict is to ship the if-statement.
    const d = parseDecision(spec);
    const says = ruleFiller(d, spec.rule);
    const answers = anchors.structuredContent.anchors.map((a) => ({ given: a.given, choice: says(a.given).choice }));
    const cal = await s.call("gatecraft_decision_calibrate", { bundle, answers, answered_by: "person" });
    assert.equal(cal.structuredContent.verdict, "write-the-rule-instead", cal.content[0].text);
    assert.match(cal.content[0].text, /^any \|/m, "a rule fill has one certainty, so the sweep is one rung");

    const ran = await s.call("gatecraft_decision_decide", { bundle, codes: { temp: 3, soc: 0, cable: 1, cycles: 0, swelling: 0 } });
    assert.equal(ran.structuredContent.action, "stop");
    const illegal = await s.call("gatecraft_decision_decide", { bundle, codes: { temp: 0, soc: 0, cable: 1, cycles: 3, swelling: 0 } });
    assert.deepEqual([illegal.structuredContent.action, illegal.structuredContent.review, illegal.structuredContent.legal], ["stop", true, false]);

    const exported = await s.call("gatecraft_decision_export", { bundle });
    assert.ok(!exported.isError, exported.content[0].text);
    assert.equal(exported.structuredContent.checkedAgainstAPerson, true);
    const mod = await import(exported.structuredContent.file);
    let wrong = 0;
    for (let row = 0; row < 2 ** d.nIn; row++) {
      const codes = decodeRow(d, row);
      if (isLegal(d, codes) && mod.decide(codes).action !== says(codes).choice) wrong += 1;
    }
    assert.equal(wrong, 0, "the module an agent wrote into the project answers every legal row as the rule does");

    // An unknown method is an error; a notification is not answered at all.
    assert.equal((await s.request("resources/list", {})).error.code, -32601);
    assert.deepEqual(s.stray, [], "notifications/initialized got no reply");
  } finally {
    await s.close();
    rmSync(out, { recursive: true, force: true });
  }
});

test("paths outside the output root are refused, and so is a key the machine does not have", async () => {
  const out = mkdtempSync(join(tmpdir(), "gatecraft-mcp-"));
  try {
    const mcp = createGatecraftMcp({ outRoot: out, key: () => null, trial: null, yosys: noYosys });
    for (const bundle of ["../..", "/etc", join(out, "..", "elsewhere"), out]) {
      const r = await mcp.callTool("gatecraft_decision_anchors", { bundle });
      assert.equal(r.isError, true, `${bundle} should be refused`);
    }
    const nokey = await mcp.callTool("gatecraft_decision_fill", { spec, with: "jev" });
    assert.equal(nokey.isError, true);
    assert.match(nokey.content[0].text, /jev\.token/);
    assert.equal((await mcp.callTool("no_such_tool", {})).isError, true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("an agent can fill a decision with its own answers, and an agent's anchors are labelled as such", async () => {
  const out = mkdtempSync(join(tmpdir(), "gatecraft-mcp-"));
  try {
    const mcp = createGatecraftMcp({ outRoot: out, trial: null, yosys: noYosys });
    const d = parseDecision(spec);
    const says = ruleFiller(d, spec.rule);
    const listed = await mcp.callTool("gatecraft_decision_situations", { spec, limit: 512 });
    assert.equal(listed.structuredContent.total, 192);
    // Answer all but one situation; the missing one must review rather than be guessed.
    const answers = listed.structuredContent.situations.slice(1).map((s) => ({ given: s.given, choice: says(s.given).choice, confidence: 0.9 }));
    const filled = await mcp.callTool("gatecraft_decision_fill", { spec, with: "answers", answers });
    assert.ok(!filled.isError, filled.content[0].text);
    assert.equal(filled.structuredContent.answered, 191);
    assert.match(filled.content[0].text, /191 situations had a single answer/, "a stated confidence is called what it is");
    assert.equal(filled.structuredContent.failed, 1);
    const missing = await mcp.callTool("gatecraft_decision_decide", { bundle: filled.structuredContent.bundle, codes: listed.structuredContent.situations[0].given });
    assert.equal(missing.structuredContent.review, true, "a situation nobody answered is handed to a person");

    const sheet = (await mcp.callTool("gatecraft_decision_anchors", { bundle: filled.structuredContent.bundle })).structuredContent.anchors;
    const cal = await mcp.callTool("gatecraft_decision_calibrate", { bundle: filled.structuredContent.bundle, answers: sheet.map((a) => ({ given: a.given, choice: says(a.given).choice })), answered_by: "agent" });
    assert.match(cal.content[0].text, /given by an agent, not a person/);
    const exported = await mcp.callTool("gatecraft_decision_export", { bundle: filled.structuredContent.bundle });
    assert.equal(exported.structuredContent.checkedAgainstAPerson, false, "an agent's anchors never count as a person's");
    assert.match(readFileSync(exported.structuredContent.file, "utf8"), /NOBODY HAS CHECKED THAT/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the guide's example is a legal decision, and repeated answers are scored by agreement", async () => {
  const out = mkdtempSync(join(tmpdir(), "gatecraft-mcp-"));
  try {
    const mcp = createGatecraftMcp({ outRoot: out, trial: null, yosys: noYosys });
    const guide = await mcp.callTool("gatecraft_decision_guide", {});
    assert.match(guide.content[0].text, /ASK THE PERSON/);
    const example = guide.structuredContent.example;
    const review = await mcp.callTool("gatecraft_decision_review", { spec: example });
    assert.ok(!review.isError, review.content[0].text);

    // Three answers for every situation: unanimous on some, split on others.
    const listed = await mcp.callTool("gatecraft_decision_situations", { spec: example, limit: 512 });
    const answers = listed.structuredContent.situations.flatMap((s, i) => {
      const choice = s.given.status === 2 ? "give_up" : "retry";
      const other = choice === "retry" ? "give_up" : "retry";
      return i % 2 ? [choice, choice, choice].map((c) => ({ given: s.given, choice: c })) : [choice, choice, other].map((c) => ({ given: s.given, choice: c }));
    });
    const filled = await mcp.callTool("gatecraft_decision_fill", { spec: example, with: "answers", answers });
    assert.ok(!filled.isError, filled.content[0].text);
    const rows = JSON.parse(readFileSync(join(filled.structuredContent.bundle, "fill.json"), "utf8")).rows.filter((r) => r?.choice);
    assert.deepEqual([...new Set(rows.map((r) => r.confidence))].sort(), [0.667, 1], "2 of 3 and 3 of 3");
    assert.ok(filled.structuredContent.settled > 0 && filled.structuredContent.settled < rows.length, "only the unanimous ones clear the 0.7 threshold");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
