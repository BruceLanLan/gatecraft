// A local JSON-RPC server that answers exactly the calls the tapeout plan makes,
// with made-up addresses and numbers. It also simulates the plan's
// transactions the way the real contracts behave: a mint checks its price and
// the supply cap, tapeout checks its fee, burns the NAND and LATCH the netlist
// uses and returns nextId + 1. Tests never talk to a real chain.
import { createServer } from "node:http";
import { selector } from "../src/keccak.mjs";
import { OPCODE, decodeElements, hexToBytes } from "../src/netlist.mjs";
import { IMPLEMENTATION_SLOT, TAPED_OUT_TOPIC } from "../src/tapeout.mjs";

export const FAKE = {
  processor: "0x1111111111111111111111111111111111111111",
  transistors: "0x2222222222222222222222222222222222222222",
  implementation: "0x3333333333333333333333333333333333333333",
  sender: "0x4444444444444444444444444444444444444444",
};

const bare = (v) => BigInt(v).toString(16).padStart(64, "0");
const word = (v) => `0x${bare(v)}`;
const emptyRevert = { error: { code: 3, message: "execution reverted", data: "0x" } };
const revertString = (text) => {
  const hex = Buffer.from(text).toString("hex");
  return `${selector("Error(string)")}${bare(32)}${bare(text.length)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};

export async function startFakeChain({
  chainId = 56,
  block = 1234,
  nextId = 42n,
  tapeoutFee = 5n * 10n ** 14n,
  mintPrice = 10n ** 12n,
  protocolFee = 3n * 10n ** 13n,
  nand = 0n,
  latch = 0n,
  supplyCap = 1_000_000n,
  minted = 999_000n,
  native = 10n ** 18n,
  simulate = true,
  issuedId = (last) => last + 1n,
} = {}) {
  const calls = [];

  const view = (to, data, s) => {
    const sel = data.slice(0, 10);
    if (to === FAKE.processor && sel === selector("transistors()")) return { result: word(BigInt(FAKE.transistors)) };
    if (to === FAKE.processor && sel === selector("nextId()")) return { result: word(s.nextId) };
    if (to === FAKE.processor && sel === selector("TAPEOUT_FEE()")) {
      if (tapeoutFee === "revert-empty") return emptyRevert;
      if (tapeoutFee === "revert-data") return { error: { code: 3, message: "execution reverted", data: "0x08c379a0" } };
      return { result: word(tapeoutFee) };
    }
    if (to === FAKE.transistors && sel === selector("mintPrice()")) return { result: word(mintPrice) };
    if (to === FAKE.transistors && sel === selector("protocolFee()")) return { result: word(protocolFee) };
    if (to === FAKE.transistors && sel === selector("supplyCap()")) return supplyCap === "none" ? emptyRevert : { result: word(supplyCap) };
    if (to === FAKE.transistors && sel === selector("minted()")) return supplyCap === "none" ? emptyRevert : { result: word(s.minted) };
    if (to === FAKE.transistors && sel === selector("balanceOf(address,uint256)")) {
      const owner = `0x${data.slice(34, 74)}`;
      const id = BigInt(`0x${data.slice(74, 138)}`);
      const held = owner === FAKE.sender ? (id === 0n ? s.nand : s.latch) : 0n;
      return { result: word(held) };
    }
    return emptyRevert;
  };

  const failed = (data) => ({ status: "0x0", returnData: data, gasUsed: "0x5208", logs: [], error: { code: 3, message: "execution reverted", data } });

  const transact = (call, s) => {
    const to = call.to.toLowerCase();
    const from = call.from.toLowerCase();
    const value = BigInt(call.value ?? "0x0");
    if (from === FAKE.sender && value > s.native) return { status: "0x0", returnData: "0x", gasUsed: "0x0", logs: [], error: { code: -38014, message: "insufficient funds for transfer" } };
    const sel = call.data.slice(0, 10);
    const args = (call.data.slice(10).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));
    if (to === FAKE.transistors && sel === selector("mint(uint256,uint256)")) {
      const [id, amount] = args;
      if (value !== mintPrice * amount + protocolFee) return failed(revertString("mint price"));
      if (supplyCap !== "none" && s.minted + amount > supplyCap) return failed(revertString("supply cap"));
      s.minted += amount;
      if (from === FAKE.sender) {
        s[id === 0n ? "nand" : "latch"] += amount;
        s.native -= value;
      }
      return { status: "0x1", returnData: "0x", gasUsed: "0xc350", logs: [] };
    }
    if (to === FAKE.processor && sel === selector("tapeout(bytes,uint32,uint32)")) {
      if (value !== (typeof tapeoutFee === "bigint" ? tapeoutFee : 0n)) return failed(revertString("tapeout fee"));
      const nIn = Number(args[1]);
      const length = Number(args[3]);
      const elements = decodeElements(hexToBytes(call.data.slice(10 + 64 * 4, 10 + 64 * 4 + length * 2)), nIn);
      const need = {
        nand: BigInt(elements.filter((e) => e.op === OPCODE.NAND).length),
        latch: BigInt(elements.filter((e) => e.op === OPCODE.LATCH).length),
      };
      const held = from === FAKE.sender ? s : { nand: 0n, latch: 0n };
      for (const [key, id] of [["nand", 0n], ["latch", 1n]]) {
        if (held[key] < need[key]) {
          return failed(`${selector("ERC1155InsufficientBalance(address,uint256,uint256,uint256)")}${bare(BigInt(from))}${bare(held[key])}${bare(need[key])}${bare(id)}`);
        }
      }
      if (from === FAKE.sender) {
        s.nand -= need.nand;
        s.latch -= need.latch;
        s.native -= value;
      }
      s.nextId = issuedId(s.nextId);
      return {
        status: "0x1",
        returnData: word(s.nextId),
        gasUsed: "0x39000",
        logs: [{ address: FAKE.processor, topics: [TAPED_OUT_TOPIC, word(s.nextId), word(BigInt(from))], data: `0x${bare(need.nand + need.latch)}${bare(need.latch)}` }],
      };
    }
    return failed("0x");
  };

  const answer = (method, params) => {
    calls.push(method);
    const s = { nand, latch, minted: supplyCap === "none" ? 0n : minted, nextId, native };
    if (method === "eth_chainId") return { result: `0x${chainId.toString(16)}` };
    if (method === "eth_blockNumber") return { result: `0x${block.toString(16)}` };
    if (method === "eth_getCode") return { result: params[0] === FAKE.processor ? "0x6080604052" : "0x" };
    if (method === "eth_getStorageAt") {
      return { result: params[0] === FAKE.processor && params[1] === IMPLEMENTATION_SLOT ? word(BigInt(FAKE.implementation)) : word(0) };
    }
    if (method === "eth_getBalance") return { result: `0x${(params[0] === FAKE.sender ? native : 0n).toString(16)}` };
    if (method === "eth_call") return view(params[0].to, params[0].data, s);
    if (method === "eth_simulateV1") {
      if (!simulate) return { error: { code: -32601, message: "the method eth_simulateV1 does not exist/is not available" } };
      return {
        result: params[0].blockStateCalls.map((b) => {
          const topUp = b.stateOverrides?.[FAKE.sender]?.balance;
          if (topUp) s.native = BigInt(topUp);
          return { number: `0x${(block + 1).toString(16)}`, calls: b.calls.map((c) => transact(c, s)) };
        }),
      };
    }
    return { error: { code: -32601, message: "method not found" } };
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...answer(method, params) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}
