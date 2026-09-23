// Handing the circuit to a fab's own flow: the file each one imports, written exactly the way
// that importer asks for it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRSTO_PROCESSORS, FIRSTO_SCHEMA, firstoImport, firstoImportText } from "../src/handoff.mjs";
import { compileSpec } from "../src/job.mjs";
import { toBlif } from "../src/blif.mjs";
import { decodeCircuit, hexToBytes } from "../src/netlist.mjs";

const VOTE = { inputs: { a: 1, b: 1, c: 1 }, outputs: { pass: { width: 1, expr: "a + b + c >= 2" } } };

test("the flow-import envelope carries the canonical bytes and exactly the fields the importer allows", () => {
  const result = compileSpec("expr", VOTE, { steps: 2000 });
  const envelope = firstoImport({ netlistHex: result.circuit.netlistHex, nIn: 3, nOut: 1 });
  // That importer refuses an unknown field, so the key set is part of the contract.
  assert.deepEqual(Object.keys(envelope), ["schema", "processor", "nIn", "nOut", "netlist"]);
  assert.equal(envelope.schema, FIRSTO_SCHEMA);
  assert.equal(envelope.processor, "TapeOut");
  assert.equal(envelope.netlist, result.circuit.netlistHex);
  assert.match(envelope.netlist, /^0x[0-9a-f]*$/);
  assert.deepEqual(FIRSTO_PROCESSORS, ["TapeOut", "Behemoth"]);
  assert.equal(firstoImport({ netlistHex: "0x00", nIn: 1, nOut: 1, processor: "Behemoth" }).processor, "Behemoth");

  const text = firstoImportText(result.circuit);
  assert.deepEqual(JSON.parse(text), { ...envelope, nIn: result.circuit.nIn, nOut: result.circuit.nOut });
  assert.ok(text.endsWith("\n"));

  for (const [bad, pattern] of [
    [{ netlistHex: "00ff", nIn: 1, nOut: 1 }, /canonical 0x bytes/],
    [{ netlistHex: "0xzz", nIn: 1, nOut: 1 }, /canonical 0x bytes/],
    [{ netlistHex: "0x00", nIn: 1, nOut: 0 }, /whole numbers/],
    [{ netlistHex: "0x00", nIn: 1, nOut: 1, processor: "Somebody" }, /TapeOut, Behemoth/],
  ]) {
    assert.throws(() => firstoImport(bad), pattern, JSON.stringify(bad));
  }
});

test("both handoff files describe the same circuit as the certificate", () => {
  const result = compileSpec("expr", VOTE, { name: "vote", steps: 2000 });
  const files = result;
  const envelope = firstoImport({ netlistHex: result.circuit.netlistHex, nIn: result.circuit.nIn, nOut: result.circuit.nOut });
  const decoded = decodeCircuit(hexToBytes(envelope.netlist), envelope.nIn, envelope.nOut);
  assert.equal(decoded.nNand, files.certificate.circuit.nand);
  assert.equal(decoded.nLatch, files.certificate.circuit.latch);
  const blif = toBlif(decoded, { name: "vote" });
  assert.match(blif, /^\.model vote$/m);
  assert.equal(blif.split("\n").filter((line) => line.startsWith(".latch")).length, decoded.nLatch);
});

// ---- would that importer take our files? Its rules, applied here, offline.

import { blifProblems, FIRSTO_MAX_NETLIST_BYTES, firstoProblems, netlistComposition } from "../src/handoff.mjs";
import { artifactFiles } from "../src/job.mjs";
import { readFileSync } from "node:fs";

const EVERY = {
  vote: VOTE,
  counter: JSON.parse(readFileSync(new URL("../examples/counter.expr.json", import.meta.url), "utf8")),
  thermostat: JSON.parse(readFileSync(new URL("../examples/thermostat.expr.json", import.meta.url), "utf8")),
  adder8: JSON.parse(readFileSync(new URL("../examples/adder8.expr.json", import.meta.url), "utf8")),
  max: JSON.parse(readFileSync(new URL("../examples/max.expr.json", import.meta.url), "utf8")),
  toggle: JSON.parse(readFileSync(new URL("../examples/toggle.expr.json", import.meta.url), "utf8")),
};

test("every example's handoff files satisfy that importer's own rules", () => {
  for (const [name, spec] of Object.entries(EVERY)) {
    const result = compileSpec("expr", spec, { steps: 2000 });
    const files = artifactFiles(name, result);
    const envelope = JSON.parse(files["circuit.firsto.json"]);
    assert.deepEqual(firstoProblems(envelope), [], `${name}: envelope`);
    assert.deepEqual(blifProblems(files["circuit.blif"]), [], `${name}: BLIF`);

    // the element counts it reads out of the bytes match the certificate
    const counts = netlistComposition(envelope.netlist);
    assert.equal(counts.nand, result.certificate.circuit.nand, `${name}: NAND count`);
    assert.equal(counts.latch, result.certificate.circuit.latch, `${name}: LATCH count`);
    assert.equal(counts.references, 0, `${name}: no REF elements`);
    assert.ok(counts.bytes <= FIRSTO_MAX_NETLIST_BYTES, `${name}: ${counts.bytes} bytes`);
    assert.equal(counts.bytes, result.certificate.circuit.netlistBytes, `${name}: byte count`);
  }
});

test("the checks catch what that importer would reject", () => {
  const good = firstoImport({ netlistHex: "0x000000030000040000000700000300000001000008", nIn: 3, nOut: 1 });
  assert.deepEqual(firstoProblems(good), []);
  assert.deepEqual(firstoProblems({ ...good, extra: 1 }), ["unsupported field extra"]);
  assert.deepEqual(firstoProblems({ ...good, schema: "other" }), [`schema must be ${FIRSTO_SCHEMA}`]);
  assert.deepEqual(firstoProblems({ ...good, processor: "Nobody" }), ["processor must be one of TapeOut, Behemoth"]);
  assert.deepEqual(firstoProblems({ ...good, nIn: -1 }), ["nIn must be a uint32 integer"]);
  assert.deepEqual(firstoProblems({ ...good, netlist: "0x0" }), ["netlist must be canonical 0x bytes, whole bytes only"]);
  assert.deepEqual(firstoProblems({ ...good, netlist: "0x0000" }), ["the netlist is truncated in a NAND"]);
  assert.deepEqual(firstoProblems({ ...good, netlist: "0x09" }), ["the netlist has unsupported opcode 9"]);
  assert.deepEqual(firstoProblems({ ...good, netlist: `0x${"00000003000004".repeat(6000)}` }), [`the netlist is 42000 bytes; the limit is ${FIRSTO_MAX_NETLIST_BYTES}`]);

  const blif = ".model m\n.inputs a b\n.outputs y\n.names a b y\n0- 1\n-0 1\n.end\n";
  assert.deepEqual(blifProblems(blif), []);
  assert.deepEqual(blifProblems(blif.replace(".end", "")), ["a BLIF import must contain exactly one .end"]);
  assert.deepEqual(blifProblems(`${blif}.model second\n.end\n`), ["a BLIF import must contain exactly one .model", "a BLIF import must contain exactly one .end"]);
  assert.deepEqual(blifProblems(blif.replace(".inputs a b", ".inputs a a")), [".inputs names must be unique"]);
  assert.deepEqual(blifProblems(blif.replace(".names a b y", ".names a b c y")), ['".names a b c y" has 3 input(s); one or two are accepted']);
  assert.deepEqual(blifProblems(".model m\n.inputs a\n.outputs y\n.names vdd\n 1\n.end\n"), ['".names vdd" has 0 input(s); one or two are accepted']);
  assert.deepEqual(blifProblems(`${blif}.latch d\n`), ['".latch d" needs an input and an output signal']);
});
