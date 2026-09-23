// Unsigned transactions that tape a netlist out on a TapeOut processor, and a
// simulation of those transactions before anyone signs them.
//
// Built only from the processor interface published in the tapeout.net
// frontend:
//   processor    TAPEOUT_FEE() view, transistors() view, nextId() view,
//                tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256),
//                event TapedOut(uint256 indexed id, address indexed author, uint32 gateCount, uint32 nState)
//   transistors  ERC-1155 with NAND as id 0 and LATCH as id 1: mintPrice() view,
//                protocolFee() view, supplyCap() view, minted() view,
//                balanceOf(address, uint256) view, mint(uint256 id, uint256 amount) payable
// The plan follows the same sequence as that frontend: mint the NAND and LATCH
// the sender is short of (each mint pays mintPrice x amount + protocolFee),
// then call tapeout paying TAPEOUT_FEE, which older processors do not have
// (a revert with no data reads as a fee of 0). tapeout burns the NAND and LATCH
// the netlist uses from the sender's balance.
//
// Checked read-only against BSC mainnet on 2026-09-15 with eth_simulateV1:
// tapeout returns nextId() + 1 (nextId() is the id issued last), and TapedOut
// records gateCount = NAND + LATCH and nState = LATCH.
//
// Nothing here signs, holds a key or broadcasts. Every address is a parameter.
import { decodeAddress, decodeUint, encodeCall, encodeTapeout, normalizeAddress } from "./abi.mjs";
import { keccak256, selector } from "./keccak.mjs";
import { bytesToHex, hexToBytes } from "./netlist.mjs";
import { sha256 } from "./sha256.mjs";

export const PLAN_FORMAT = "gatecraft.tapeout-plan/2";
// EIP-1967: keccak256("eip1967.proxy.implementation") - 1
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const TAPED_OUT_TOPIC = bytesToHex(keccak256(new TextEncoder().encode("TapedOut(uint256,address,uint32,uint32)")));
const ERROR_STRING = selector("Error(string)");
const INSUFFICIENT_TOKENS = selector("ERC1155InsufficientBalance(address,uint256,uint256,uint256)");
const NAND_ID = 0n;
const LATCH_ID = 1n;
const TOKEN_NAMES = { 0: "NAND", 1: "LATCH" };

export async function rpc(url, method, params) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`RPC ${method} did not answer: ${error.message}`);
  }
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) {
    const error = new Error(`RPC ${method}: ${body.error.message}`);
    error.rpc = body.error;
    throw error;
  }
  return body.result;
}

const isEmptyRevert = (error) => {
  const e = error.rpc;
  if (!e || !/revert/i.test(String(e.message ?? ""))) return false;
  return e.data === undefined || e.data === null || e.data === "0x";
};

const hexValue = (v) => `0x${BigInt(v).toString(16)}`;
const words = (hex) => (String(hex).replace(/^0x/, "").match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));

// Reads everything the plan needs at one block, so the numbers agree with each other.
export async function readChain({ rpcUrl, processor, from }) {
  const target = normalizeAddress(processor, "processor");
  const sender = normalizeAddress(from, "from");
  const chainId = Number(BigInt(await rpc(rpcUrl, "eth_chainId", [])));
  const block = await rpc(rpcUrl, "eth_blockNumber", []);
  const call = async (to, data) => rpc(rpcUrl, "eth_call", [{ to, data }, block]);
  // A view some contracts lack: a revert with no data reads as null.
  const optional = async (to, signature) => {
    try {
      return decodeUint(await call(to, encodeCall(signature)));
    } catch (error) {
      if (isEmptyRevert(error)) return null;
      throw error;
    }
  };

  const code = await rpc(rpcUrl, "eth_getCode", [target, block]);
  if (!code || code === "0x") throw new Error(`there is no contract at processor ${target}`);
  const implementation = decodeAddress(await rpc(rpcUrl, "eth_getStorageAt", [target, IMPLEMENTATION_SLOT, block]));
  const transistors = decodeAddress(await call(target, encodeCall("transistors()")));
  if (/^0x0{40}$/.test(transistors)) throw new Error(`processor ${target} reports no transistors contract`);
  const nextId = decodeUint(await call(target, encodeCall("nextId()")));
  let tapeoutFee;
  try {
    tapeoutFee = decodeUint(await call(target, encodeCall("TAPEOUT_FEE()")));
  } catch (error) {
    if (!isEmptyRevert(error)) throw new Error(`could not read TAPEOUT_FEE() from ${target}; check that it is a TapeOut processor (${error.message})`);
    tapeoutFee = 0n;
  }
  const mintPrice = decodeUint(await call(transistors, encodeCall("mintPrice()")));
  const protocolFee = decodeUint(await call(transistors, encodeCall("protocolFee()")));
  const supplyCap = await optional(transistors, "supplyCap()");
  const minted = await optional(transistors, "minted()");
  const nand = decodeUint(await call(transistors, encodeCall("balanceOf(address,uint256)", [sender, NAND_ID])));
  const latch = decodeUint(await call(transistors, encodeCall("balanceOf(address,uint256)", [sender, LATCH_ID])));
  const native = BigInt(await rpc(rpcUrl, "eth_getBalance", [sender, block]));
  return {
    chainId,
    block: Number(BigInt(block)),
    processor: target,
    implementation,
    transistors,
    from: sender,
    nextId,
    tapeoutFee,
    mintPrice,
    protocolFee,
    supply: supplyCap === null || minted === null ? null : { cap: supplyCap, minted },
    balances: { nand, latch, native },
  };
}

export function planTapeout({ name, netlist, chain, expectChainId, expectImplementation }) {
  const guards = [];
  if (expectChainId !== undefined) {
    if (chain.chainId !== expectChainId) throw new Error(`RPC is on chain ${chain.chainId}, expected ${expectChainId}; refusing`);
    guards.push(`chain id is ${expectChainId}`);
  }
  if (expectImplementation !== undefined) {
    const want = normalizeAddress(expectImplementation, "expected implementation");
    if (chain.implementation !== want) throw new Error(`processor implementation is ${chain.implementation}, expected ${want}; refusing`);
    guards.push(`processor implementation is ${want}`);
  }
  const need = { nand: BigInt(netlist.nand), latch: BigInt(netlist.latch) };
  const short = {
    nand: need.nand > chain.balances.nand ? need.nand - chain.balances.nand : 0n,
    latch: need.latch > chain.balances.latch ? need.latch - chain.balances.latch : 0n,
  };
  let supply = null;
  if (chain.supply) {
    const left = chain.supply.cap > chain.supply.minted ? chain.supply.cap - chain.supply.minted : 0n;
    if (short.nand + short.latch > left) {
      throw new Error(`this circuit needs ${short.nand} more NAND and ${short.latch} more LATCH than ${chain.from} holds, but only ${left} can still be minted (cap ${chain.supply.cap}, minted ${chain.supply.minted}); get them another way, then plan again`);
    }
    supply = { cap: chain.supply.cap.toString(), minted: chain.supply.minted.toString(), left: left.toString() };
  }
  const transactions = [];
  const add = (purpose, to, value, data) => transactions.push({ purpose, from: chain.from, to, value: value.toString(), data });
  if (short.nand > 0n) add(`mint ${short.nand} NAND`, chain.transistors, chain.mintPrice * short.nand + chain.protocolFee, encodeCall("mint(uint256,uint256)", [NAND_ID, short.nand]));
  if (short.latch > 0n) add(`mint ${short.latch} LATCH`, chain.transistors, chain.mintPrice * short.latch + chain.protocolFee, encodeCall("mint(uint256,uint256)", [LATCH_ID, short.latch]));
  add(`tapeout ${name ?? "circuit"}`, chain.processor, chain.tapeoutFee, encodeTapeout(netlist));
  const totalValue = transactions.reduce((sum, tx) => sum + BigInt(tx.value), 0n);
  const warnings = [];
  if (chain.balances.native < totalValue) warnings.push(`${chain.from} holds ${chain.balances.native} wei, less than the ${totalValue} wei these transactions send (gas not included)`);

  return {
    format: PLAN_FORMAT,
    unsigned: true,
    note: "Unsigned. Check it, then sign and send the transactions in order from your own wallet. expectedCircuitId holds only if nobody else tapes out on this processor first.",
    chainId: chain.chainId,
    readAtBlock: chain.block,
    processor: chain.processor,
    implementation: chain.implementation,
    transistors: chain.transistors,
    from: chain.from,
    circuit: {
      name: name ?? null,
      nIn: netlist.nIn,
      nOut: netlist.nOut,
      nand: netlist.nand,
      latch: netlist.latch,
      netlistBytes: hexToBytes(netlist.netlistHex).length,
      netlistSha256: sha256(hexToBytes(netlist.netlistHex)),
    },
    fees: { tapeoutFee: chain.tapeoutFee.toString(), mintPrice: chain.mintPrice.toString(), protocolFee: chain.protocolFee.toString() },
    supply,
    balances: { nand: chain.balances.nand.toString(), latch: chain.balances.latch.toString(), native: chain.balances.native.toString() },
    expectedCircuitId: (chain.nextId + 1n).toString(),
    guards,
    warnings,
    transactions,
    totalValue: totalValue.toString(),
  };
}

// Why a simulated call reverted, in words where the revert data allows.
function revertReason(call) {
  const data = [call.error?.data, call.returnData].find((d) => typeof d === "string" && d.length > 2) ?? "0x";
  if (data.startsWith(ERROR_STRING)) {
    try {
      const body = data.slice(10);
      const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
      const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`)) * 2;
      return `reverted: ${new TextDecoder().decode(hexToBytes(body.slice(offset + 64, offset + 64 + length)))}`;
    } catch {
      // malformed Error(string): report the raw data below
    }
  }
  if (data.startsWith(INSUFFICIENT_TOKENS)) {
    const [sender, balance, needed, id] = words(data.slice(10));
    return `reverted: 0x${sender.toString(16).padStart(40, "0")} holds ${balance} ${TOKEN_NAMES[id] ?? `of token ${id}`}, needs ${needed}`;
  }
  if (data.length > 2) return `reverted with ${data.length > 74 ? `${data.slice(0, 74)}…` : data}`;
  return call.error?.message ?? "reverted";
}

// Runs the plan's transactions in order on top of the block the plan was read
// at, with eth_simulateV1. Nothing is signed or sent. If the sender's native
// balance is below the total value, the simulation tops it up and says so, so
// the contracts' own checks are still exercised. ok means every call succeeds,
// the tapeout returns the expected circuit id, and the processor records the
// netlist's element and latch counts.
export async function simulatePlan({ rpcUrl, plan }) {
  const total = BigInt(plan.totalValue);
  const toppedUp = BigInt(plan.balances.native) < total;
  const blockCalls = { calls: plan.transactions.map((tx) => ({ from: tx.from, to: tx.to, value: hexValue(tx.value), data: tx.data })) };
  if (toppedUp) blockCalls.stateOverrides = { [plan.from]: { balance: hexValue(total) } };
  let result;
  try {
    result = await rpc(rpcUrl, "eth_simulateV1", [{ blockStateCalls: [blockCalls] }, hexValue(plan.readAtBlock)]);
  } catch (error) {
    if (error.rpc?.code === -32601 || /not (found|available|supported)|does not exist|unsupported/i.test(error.rpc?.message ?? "")) {
      const unsupported = new Error("this RPC does not support eth_simulateV1, so the plan could not be simulated");
      unsupported.unsupported = true;
      throw unsupported;
    }
    throw error;
  }
  const calls = result?.[0]?.calls;
  if (!Array.isArray(calls) || calls.length !== plan.transactions.length) throw new Error("eth_simulateV1 returned a result that does not match the plan's transactions");

  const report = calls.map((c, i) => {
    const entry = { purpose: plan.transactions[i].purpose, ok: c.status === "0x1", gasUsed: Number(BigInt(c.gasUsed ?? "0x0")) };
    if (!entry.ok) entry.error = revertReason(c);
    return entry;
  });
  const simulation = {
    method: "eth_simulateV1",
    atBlock: plan.readAtBlock,
    senderToppedUp: toppedUp,
    calls: report,
    gasUsed: report.reduce((sum, c) => sum + c.gasUsed, 0),
    problems: [],
  };
  if (report.every((c) => c.ok)) {
    const last = calls.at(-1);
    if (String(last.returnData ?? "").length < 66) {
      simulation.problems.push("the simulated tapeout returned no circuit id");
    } else {
      simulation.circuitId = decodeUint(last.returnData).toString();
      if (simulation.circuitId !== plan.expectedCircuitId) simulation.problems.push(`the simulated tapeout returned circuit id ${simulation.circuitId}, the plan expected ${plan.expectedCircuitId}`);
    }
    const log = (last.logs ?? []).find((l) => String(l.address).toLowerCase() === plan.processor && String(l.topics?.[0]).toLowerCase() === TAPED_OUT_TOPIC);
    if (!log) {
      simulation.problems.push("the simulated tapeout emitted no TapedOut event");
    } else {
      const [gateCount, nState] = words(log.data).map(Number);
      simulation.recorded = { gateCount, nState };
      const elements = plan.circuit.nand + plan.circuit.latch;
      if (gateCount !== elements || nState !== plan.circuit.latch) {
        simulation.problems.push(`the processor recorded ${gateCount} elements and ${nState} state bits, but the netlist has ${elements} elements and ${plan.circuit.latch} latches`);
      }
    }
  } else {
    simulation.problems.push("a transaction would revert");
  }
  simulation.ok = simulation.problems.length === 0;
  return simulation;
}
