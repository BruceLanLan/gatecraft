#!/usr/bin/env node
// Does the chain compute the same answers as this compiler's own simulator?
//
//   node tools/chain-eval-check.mjs --rpc URL --circuits 0x… --id 3 [--rows 24]
//
// Read-only: no wallet, no signature, no transaction, nothing spent. See src/chaincheck.mjs.
import { parseArgs } from "node:util";
import { chainCheck } from "../src/chaincheck.mjs";

const { values } = parseArgs({
  options: { rpc: { type: "string" }, circuits: { type: "string" }, id: { type: "string" }, rows: { type: "string", default: "24" }, help: { type: "boolean", short: "h" } },
});
if (values.help || !values.rpc || !values.circuits || values.id === undefined) {
  console.log("Usage: node tools/chain-eval-check.mjs --rpc URL --circuits ADDRESS --id N [--rows 24]");
  process.exit(values.help ? 0 : 1);
}

const result = await chainCheck({ rpcUrl: values.rpc, circuits: values.circuits, id: values.id, rows: Number(values.rows) });
console.log(`circuit #${result.id} on ${result.contract}`);
console.log(`  chain says: ${result.shape.nIn} in, ${result.shape.nOut} out, ${result.shape.nState} state, ${result.shape.gates} gates`);
console.log(`  netlist: ${result.netlistBytes} bytes, decoded here as ${result.nand} NAND + ${result.latch} LATCH`);
if (!result.packing) {
  console.log(`  ${result.reason}`);
  process.exit(2);
}
console.log(`  packing: ${result.packing}`);
for (const row of result.wrong.slice(0, 3)) {
  console.log(`  row ${row.row}: chain ${row.chain.outputs.join("")}${row.chain.next.length ? `/${row.chain.next.join("")}` : ""}, here ${row.here.outputs.join("")}${row.here.next.length ? `/${row.here.next.join("")}` : ""}`);
}
console.log(`  ${result.rowsChecked - result.wrong.length} / ${result.rowsChecked} sampled rows agree with simulate()${result.rowsTotal > result.rowsChecked ? ` (of ${result.rowsTotal})` : ""}`);
process.exit(result.agreed ? 0 : 1);
