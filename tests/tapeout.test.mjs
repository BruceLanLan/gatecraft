import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAddress, decodeUint, encodeCall, encodeTapeout } from "../src/abi.mjs";
import { keccak256, selector } from "../src/keccak.mjs";
import { PLAN_FORMAT, planTapeout, readChain, simulatePlan } from "../src/tapeout.mjs";
import { FAKE, startFakeChain } from "./fake-chain.mjs";
import { ROOT, runScript, tempDir } from "./helpers.mjs";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

function runAsync(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function compileXor() {
  const out = tempDir();
  const r = runScript("scripts/compile-table.mjs", ["--fn", "(x&1)^((x>>1)&1)", "--nIn", "2", "--nOut", "1", "--name", "xor2", "--steps", "5000", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  return join(out, "circuit.netlist.json");
}

function compileCounter() {
  const out = tempDir();
  const r = runScript("scripts/compile-fsm.mjs", ["--spec", join(ROOT, "examples", "counter.fsm.json"), "--name", "counter", "--steps", "5000", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  return join(out, "circuit.netlist.json");
}

async function withChain(options, body) {
  const chainServer = await startFakeChain(options);
  try {
    return await body(chainServer);
  } finally {
    await chainServer.close();
  }
}

const planFor = async (chainServer, netlist, extra = {}) => {
  const chain = await readChain({ rpcUrl: chainServer.url, processor: FAKE.processor, from: FAKE.sender });
  return planTapeout({ name: "demo", netlist, chain, ...extra });
};

test("keccak256 matches the published test vectors", () => {
  assert.equal(hex(keccak256(new Uint8Array())), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(hex(keccak256(new TextEncoder().encode("abc"))), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
});

test("tapeout calldata matches an independent ABI encoding", () => {
  for (const len of [0, 1, 7, 31, 32, 33, 64, 100]) {
    const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255));
    const expected = Buffer.concat([
      Buffer.from(selector("tapeout(bytes,uint32,uint32)").slice(2), "hex"),
      Buffer.alloc(31), Buffer.from([0x60]),
      Buffer.alloc(28), Buffer.from([0, 0, 0, 5]),
      Buffer.alloc(28), Buffer.from([0, 0, 0, 3]),
      Buffer.alloc(28), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(len); return b; })(),
      bytes,
      Buffer.alloc((32 - (len % 32)) % 32),
    ]);
    assert.equal(encodeTapeout({ netlistHex: `0x${bytes.toString("hex")}`, nIn: 5, nOut: 3 }), `0x${expected.toString("hex")}`);
  }
  assert.throws(() => encodeTapeout({ netlistHex: "0xabc", nIn: 1, nOut: 1 }), /whole bytes/);
});

test("static calls and return values encode and decode", () => {
  const data = encodeCall("balanceOf(address,uint256)", [FAKE.sender, 1n]);
  assert.equal(data, `${selector("balanceOf(address,uint256)")}${"0".repeat(24)}${FAKE.sender.slice(2)}${"0".repeat(63)}1`);
  assert.throws(() => encodeCall("mint(uint256,uint256)", [0n]), /takes 2 arguments/);
  assert.throws(() => encodeCall("f(uint32)", [2n ** 32n]), /does not fit/);
  assert.throws(() => encodeCall("f(address)", ["0x1234"]), /20-byte/);
  assert.equal(decodeUint(`0x${"0".repeat(62)}ff`), 255n);
  assert.equal(decodeAddress(`0x${"0".repeat(24)}${FAKE.processor.slice(2)}`), FAKE.processor);
  assert.throws(() => decodeAddress(`0x${"f".repeat(64)}`), /not an address/);
});

test("the plan mints only what the sender lacks and pays the fees the chain reports", async () => {
  await withChain({ nand: 2n, latch: 0n }, async (chainServer) => {
    const netlist = { nIn: 2, nOut: 1, nand: 6, latch: 1, netlistHex: "0x0000000200000301000004" };
    const plan = await planFor(chainServer, netlist, { expectChainId: 56, expectImplementation: FAKE.implementation });
    assert.equal(plan.format, PLAN_FORMAT);
    assert.equal(plan.unsigned, true);
    assert.equal(plan.expectedCircuitId, "43", "nextId() is the id issued last");
    assert.equal(plan.readAtBlock, 1234);
    assert.deepEqual(plan.supply, { cap: "1000000", minted: "999000", left: "1000" });
    assert.deepEqual(plan.balances, { nand: "2", latch: "0", native: String(10n ** 18n) });
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(plan.transactions.map((t) => t.purpose), ["mint 4 NAND", "mint 1 LATCH", "tapeout demo"]);
    const [mintNand, mintLatch, tapeout] = plan.transactions;
    assert.equal(mintNand.to, FAKE.transistors);
    assert.equal(mintNand.value, (10n ** 12n * 4n + 3n * 10n ** 13n).toString());
    assert.equal(mintNand.data, encodeCall("mint(uint256,uint256)", [0n, 4n]));
    assert.equal(mintLatch.data, encodeCall("mint(uint256,uint256)", [1n, 1n]));
    assert.equal(tapeout.to, FAKE.processor);
    assert.equal(tapeout.value, (5n * 10n ** 14n).toString());
    assert.equal(tapeout.data, encodeTapeout(netlist));
    assert.equal(BigInt(plan.totalValue), plan.transactions.reduce((s, t) => s + BigInt(t.value), 0n));
    for (const tx of plan.transactions) assert.deepEqual(Object.keys(tx).sort(), ["data", "from", "purpose", "to", "value"]);
  });
});

test("a sender holding enough transistors gets a single tapeout transaction", async () => {
  await withChain({ nand: 100n, latch: 100n }, async (chainServer) => {
    const plan = await planFor(chainServer, { nIn: 1, nOut: 1, nand: 2, latch: 1, netlistHex: "0x00" }, { name: undefined });
    assert.deepEqual(plan.transactions.map((t) => t.purpose), ["tapeout circuit"]);
  });
});

test("a plan needing more than the contract can still mint is refused; a contract without a cap is not checked", async () => {
  const netlist = { nIn: 1, nOut: 1, nand: 2, latch: 1, netlistHex: "0x00" };
  await withChain({ supplyCap: 100n, minted: 98n }, async (chainServer) => {
    await assert.rejects(planFor(chainServer, netlist), /needs 2 more NAND and 1 more LATCH .* only 2 can still be minted \(cap 100, minted 98\)/);
  });
  await withChain({ supplyCap: "none" }, async (chainServer) => {
    const plan = await planFor(chainServer, netlist);
    assert.equal(plan.supply, null);
    assert.equal(plan.transactions.length, 3);
  });
});

test("a sender without enough native tokens gets a warning, not a refusal", async () => {
  await withChain({ native: 0n }, async (chainServer) => {
    const plan = await planFor(chainServer, { nIn: 1, nOut: 1, nand: 2, latch: 0, netlistHex: "0x00" });
    assert.match(plan.warnings[0], /holds 0 wei, less than the \d+ wei these transactions send/);
  });
});

test("a processor without TAPEOUT_FEE reads as fee 0; any other failure is refused", async () => {
  await withChain({ tapeoutFee: "revert-empty" }, async (empty) => {
    const chain = await readChain({ rpcUrl: empty.url, processor: FAKE.processor, from: FAKE.sender });
    assert.equal(chain.tapeoutFee, 0n);
  });
  await withChain({ tapeoutFee: "revert-data" }, async (withData) => {
    await assert.rejects(readChain({ rpcUrl: withData.url, processor: FAKE.processor, from: FAKE.sender }), /check that it is a TapeOut processor/);
    await assert.rejects(readChain({ rpcUrl: withData.url, processor: FAKE.transistors, from: FAKE.sender }), /no contract at processor/);
  });
});

test("guards refuse the wrong chain or implementation", async () => {
  await withChain({ chainId: 97 }, async (chainServer) => {
    const chain = await readChain({ rpcUrl: chainServer.url, processor: FAKE.processor, from: FAKE.sender });
    const netlist = { nIn: 1, nOut: 1, nand: 2, latch: 0, netlistHex: "0x00" };
    assert.throws(() => planTapeout({ netlist, chain, expectChainId: 56 }), /chain 97, expected 56/);
    assert.throws(() => planTapeout({ netlist, chain, expectImplementation: FAKE.transistors }), /implementation is .* expected/);
  });
});

test("simulation runs the mints and the tapeout in order and confirms the circuit", async () => {
  const netlist = JSON.parse(readFileSync(compileCounter(), "utf8"));
  await withChain({}, async (chainServer) => {
    const plan = await planFor(chainServer, netlist);
    const sim = await simulatePlan({ rpcUrl: chainServer.url, plan });
    assert.equal(sim.ok, true, JSON.stringify(sim));
    assert.deepEqual(sim.calls.map((c) => [c.purpose, c.ok]), [[`mint ${netlist.nand} NAND`, true], [`mint ${netlist.latch} LATCH`, true], ["tapeout demo", true]]);
    assert.equal(sim.circuitId, plan.expectedCircuitId);
    assert.deepEqual(sim.recorded, { gateCount: netlist.nand + netlist.latch, nState: netlist.latch });
    assert.equal(sim.senderToppedUp, false);
    assert.ok(sim.gasUsed > 0);
    assert.equal(chainServer.calls.some((m) => /^eth_send/.test(m)), false);
  });
});

test("simulation tops up a sender without native tokens and says so", async () => {
  const netlist = JSON.parse(readFileSync(compileXor(), "utf8"));
  await withChain({ native: 0n }, async (chainServer) => {
    const sim = await simulatePlan({ rpcUrl: chainServer.url, plan: await planFor(chainServer, netlist) });
    assert.equal(sim.ok, true, JSON.stringify(sim));
    assert.equal(sim.senderToppedUp, true);
  });
});

test("simulation explains what would revert, and catches an unexpected circuit id", async () => {
  const netlist = JSON.parse(readFileSync(compileXor(), "utf8"));
  await withChain({}, async (chainServer) => {
    const plan = await planFor(chainServer, netlist);
    plan.transactions[0].value = "1";
    const sim = await simulatePlan({ rpcUrl: chainServer.url, plan });
    assert.equal(sim.ok, false);
    assert.equal(sim.calls[0].error, "reverted: mint price");
    assert.match(sim.calls[1].error, new RegExp(`^reverted: ${FAKE.sender} holds 0 NAND, needs ${netlist.nand}$`));
  });
  await withChain({ supplyCap: 10n ** 9n, minted: 10n ** 9n - BigInt(netlist.nand) }, async (chainServer) => {
    const plan = await planFor(chainServer, netlist);
    await withChain({ supplyCap: 10n ** 9n, minted: 10n ** 9n }, async (fullChain) => {
      const sim = await simulatePlan({ rpcUrl: fullChain.url, plan });
      assert.equal(sim.calls[0].error, "reverted: supply cap");
    });
  });
  await withChain({ issuedId: (last) => last }, async (chainServer) => {
    const sim = await simulatePlan({ rpcUrl: chainServer.url, plan: await planFor(chainServer, netlist) });
    assert.equal(sim.ok, false);
    assert.deepEqual(sim.problems, ["the simulated tapeout returned circuit id 42, the plan expected 43"]);
  });
});

test("an RPC without eth_simulateV1 is reported as such", async () => {
  await withChain({ simulate: false }, async (chainServer) => {
    const plan = await planFor(chainServer, { nIn: 1, nOut: 1, nand: 2, latch: 0, netlistHex: "0x00" });
    await assert.rejects(simulatePlan({ rpcUrl: chainServer.url, plan }), (error) => error.unsupported === true && /does not support eth_simulateV1/.test(error.message));
  });
});

test("tapeout-manifest CLI simulates, then writes an unsigned plan file", async () => {
  const netlistPath = compileXor();
  const planPath = join(tempDir(), "plan.json");
  await withChain({}, async (chainServer) => {
    const r = await runAsync("scripts/tapeout-manifest.mjs", ["--netlist", netlistPath, "--rpc", chainServer.url, "--processor", FAKE.processor, "--from", FAKE.sender, "--chain-id", "56", "--expect-implementation", FAKE.implementation, "--out", planPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /xor2: 2 unsigned transactions, .* expected circuit id 43 \(block 1234\); simulated ok: circuit id 43, \d+ gas/);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const netlist = JSON.parse(readFileSync(netlistPath, "utf8"));
    assert.equal(plan.transactions.at(-1).data, encodeTapeout(netlist));
    assert.equal(plan.circuit.nand, netlist.nand);
    assert.equal(plan.simulation.ok, true);
    assert.equal(chainServer.calls.some((m) => /^eth_send/.test(m)), false);

    const bad = await runAsync("scripts/tapeout-manifest.mjs", ["--netlist", netlistPath, "--rpc", chainServer.url, "--processor", FAKE.processor, "--from", FAKE.sender, "--expect-implementation", FAKE.transistors]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^error: processor implementation/);
  });
});

test("tapeout-manifest refuses to write a plan the simulation says would fail", async () => {
  const netlistPath = compileXor();
  const planPath = join(tempDir(), "plan.json");
  await withChain({ issuedId: (last) => last }, async (chainServer) => {
    const r = await runAsync("scripts/tapeout-manifest.mjs", ["--netlist", netlistPath, "--rpc", chainServer.url, "--processor", FAKE.processor, "--from", FAKE.sender, "--out", planPath]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^error: simulated at block 1234, this plan would fail; nothing written/);
    assert.match(r.stderr, /returned circuit id 42, the plan expected 43/);
    assert.equal(existsSync(planPath), false);
  });
  await withChain({ simulate: false }, async (chainServer) => {
    const args = ["--netlist", netlistPath, "--rpc", chainServer.url, "--processor", FAKE.processor, "--from", FAKE.sender, "--out", planPath];
    const unsupported = await runAsync("scripts/tapeout-manifest.mjs", args);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /does not support eth_simulateV1.*--skip-simulation/);
    const skipped = await runAsync("scripts/tapeout-manifest.mjs", [...args, "--skip-simulation"]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /; not simulated/);
    assert.equal("simulation" in JSON.parse(readFileSync(planPath, "utf8")), false);
  });
});

test("tapeout-manifest refuses a netlist file whose counts do not match its bytes", () => {
  const netlistPath = compileXor();
  const json = JSON.parse(readFileSync(netlistPath, "utf8"));
  writeFileSync(netlistPath, JSON.stringify({ ...json, nand: json.nand - 1 }));
  const r = runScript("scripts/tapeout-manifest.mjs", ["--netlist", netlistPath, "--rpc", "http://127.0.0.1:9", "--processor", FAKE.processor, "--from", FAKE.sender]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /do not match its netlist bytes/);
});

test("no file outside tests/ hardcodes a contract address", () => {
  const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return [".git", "node_modules", "out", "tests"].includes(entry.name) ? [] : walk(path);
    return [path];
  });
  const files = walk(".");
  assert.ok(files.includes(join("src", "tapeout.mjs")) && files.includes("README.md"));
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.equal(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.test(text), false, `${f} contains a 20-byte address literal`);
  }
});
