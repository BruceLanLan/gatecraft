// Checking a taped-out circuit against the chain, against a fake chain that answers the way
// the real one does — and against one that lies, which must be caught.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { PACKINGS, chainCheck, readCircuit } from "../src/chaincheck.mjs";
import { compileSpec } from "../src/job.mjs";
import { decodeCircuit, hexToBytes, simulate } from "../src/netlist.mjs";
import { selector } from "../src/keccak.mjs";

const VOTE = { inputs: { a: 1, b: 1, c: 1 }, outputs: { pass: { width: 1, expr: "a + b + c >= 2" } } };
const COUNTER = {
  inputs: { press: 1 },
  state: { count: { width: 4, next: "press ? (count == 9 ? 0 : count + 1) : count" } },
  outputs: { digit: { width: 4, expr: "count" } },
};
const ADDRESS = "0x00000000000000000000000000000000000c1274";

const pad = (hex) => hex.padStart(64, "0");
const bytesWord = (hex) => {
  const raw = hex.slice(2);
  return pad((raw.length / 2).toString(16)) + raw.padEnd(Math.max(64, Math.ceil(raw.length / 64) * 64), "0");
};

// A chain that holds one circuit and evaluates it the way the real contract does.
async function fakeChain(spec, { lie = false, packing = PACKINGS.packed } = {}) {
  const compiled = compileSpec("expr", spec, { steps: 2000 });
  const circuit = decodeCircuit(hexToBytes(compiled.circuit.netlistHex), compiled.circuit.nIn, compiled.circuit.nOut);
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { data } = JSON.parse(body).params[0];
      const which = data.slice(0, 10);
      seen.push(which);
      const answer = (hex) => res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${hex}` }));
      res.writeHead(200, { "content-type": "application/json" });
      if (which === selector("circuitInfo(uint256)")) {
        return answer(pad(circuit.nIn.toString(16)) + pad(circuit.nOut.toString(16)) + pad(circuit.nLatch.toString(16)) + pad((circuit.nNand + circuit.nLatch).toString(16)));
      }
      if (which === selector("netlist(uint256)")) return answer(pad("20") + bytesWord(compiled.circuit.netlistHex));
      // eval(id, inputs) / step(id, state, inputs): the arguments arrive as packed bytes
      const args = data.slice(10);
      const readBytes = (slot) => {
        const at = Number.parseInt(args.slice(slot * 64, (slot + 1) * 64), 16) * 2;
        const length = Number.parseInt(args.slice(at, at + 64), 16);
        return `0x${args.slice(at + 64, at + 64 + length * 2)}`;
      };
      if (which === selector("eval(uint256,bytes)")) {
        const inputs = packing.unpack(readBytes(1), circuit.nIn);
        const out = [...simulate(circuit, inputs, new Uint8Array()).outputs];
        if (lie) out[0] ^= 1;
        return answer(pad("20") + bytesWord(packing.pack(out)));
      }
      if (which === selector("step(uint256,bytes,bytes)")) {
        const state = packing.unpack(readBytes(1), circuit.nLatch);
        const inputs = packing.unpack(readBytes(2), circuit.nIn);
        const step = simulate(circuit, inputs, Uint8Array.from(state));
        const next = [...step.newState];
        if (lie) next[0] ^= 1;
        return answer(pad("40") + pad("80") + bytesWord(packing.pack(next)).slice(0, 64 + Math.max(64, 0)) + bytesWord(packing.pack([...step.outputs])));
      }
      return answer(pad("0"));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, compiled, circuit, seen, close: () => new Promise((done) => server.close(done)) };
}

test("a circuit that the chain evaluates the same way passes, and its netlist is compared too", async () => {
  const chain = await fakeChain(VOTE);
  try {
    const result = await chainCheck({ rpcUrl: chain.url, circuits: ADDRESS, id: 7, rows: 8, netlistHex: chain.compiled.circuit.netlistHex });
    assert.equal(result.agreed, true);
    assert.equal(result.packing, PACKINGS.packed.label);
    assert.equal(result.rowsChecked, 8);
    assert.deepEqual(result.wrong, []);
    assert.equal(result.matchesGiven, true);
    assert.deepEqual([result.nand, result.latch], [chain.circuit.nNand, 0]);
    assert.equal(result.shape.nIn, 3);
    // only reads: eth_call and nothing else
    assert.ok(chain.seen.every((s) => [selector("circuitInfo(uint256)"), selector("netlist(uint256)"), selector("eval(uint256,bytes)")].includes(s)));

    const other = await chainCheck({ rpcUrl: chain.url, circuits: ADDRESS, id: 7, rows: 4, netlistHex: "0xdeadbeef" });
    assert.equal(other.matchesGiven, false, "a different netlist is reported, not hidden");
  } finally {
    await chain.close();
  }
});

test("a chain that answers differently is caught, with the rows that disagree", async () => {
  const chain = await fakeChain(VOTE, { lie: true });
  try {
    const result = await chainCheck({ rpcUrl: chain.url, circuits: ADDRESS, id: 1, rows: 8 });
    assert.equal(result.agreed, false);
    assert.equal(result.packing, null, "a chain that never matches has no packing to report");
    assert.match(result.reason, /could not tell how the chain packs/);
  } finally {
    await chain.close();
  }
});

test("a circuit with memory is checked through step(), state and all", async () => {
  const chain = await fakeChain(COUNTER);
  try {
    const result = await chainCheck({ rpcUrl: chain.url, circuits: ADDRESS, id: 2, rows: 12 });
    assert.equal(result.latch, 4);
    assert.equal(result.rowsTotal, 32);
    assert.equal(result.agreed, true, JSON.stringify(result.wrong.slice(0, 2)));
    assert.ok(chain.seen.includes(selector("step(uint256,bytes,bytes)")));
  } finally {
    await chain.close();
  }
});

test("reading a circuit that is not there says so", async () => {
  const chain = await fakeChain(VOTE);
  try {
    const empty = { ...chain, url: chain.url };
    await assert.rejects(readCircuit({ rpcUrl: empty.url, circuits: ADDRESS, id: 3, fetch: async () => ({ json: async () => ({ result: `0x${"0".repeat(256)}` }) }) }), /has no gates/);
    await assert.rejects(readCircuit({ rpcUrl: chain.url, circuits: "not-an-address", id: 1 }), /address/);
  } finally {
    await chain.close();
  }
});
