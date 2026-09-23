// tapeout-manifest: a compiled netlist in, the unsigned transactions that tape
// it out on a TapeOut processor out. Reads fees, supply, balances and the next
// circuit id from the chain, then simulates the transactions in order with
// eth_simulateV1. Never signs and never sends.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readNetlist } from "../src/artifacts.mjs";
import { parseCount, run } from "../src/cli.mjs";
import { planTapeout, readChain, simulatePlan } from "../src/tapeout.mjs";

const USAGE = `
Usage:
  node scripts/tapeout-manifest.mjs --netlist out/NAME/circuit.netlist.json \\
       --rpc URL --processor ADDRESS --from ADDRESS \\
       [--chain-id N] [--expect-implementation ADDRESS] [--skip-simulation] [--out plan.json]

--processor              the processor (circuits) contract to tape out on
--from                   the wallet that will sign; its NAND/LATCH balances decide what to mint
--chain-id               refuse unless the RPC is on this chain
--expect-implementation  refuse unless the processor's EIP-1967 implementation is this address
                         (a processor that is not a proxy reads as the zero address)
--skip-simulation        do not run the transactions through eth_simulateV1 first
--out                    write the plan here instead of printing it

The plan is unsigned JSON: a list of transactions to sign and send in order.
It is refused when the transistors contract cannot mint what is missing.
Before it is written, the transactions are simulated in order on the block the
plan was read at; if any would revert, or the tapeout would not produce the
expected circuit, nothing is written and the exit code is 2.
`;

run(USAGE, async () => {
  const { values } = parseArgs({
    options: {
      netlist: { type: "string" },
      rpc: { type: "string" },
      processor: { type: "string" },
      from: { type: "string" },
      "chain-id": { type: "string" },
      "expect-implementation": { type: "string" },
      "skip-simulation": { type: "boolean" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  for (const flag of ["netlist", "rpc", "processor", "from"]) if (!values[flag]) throw new Error(`--${flag} is required (see --help)`);
  const { json } = readNetlist(values.netlist);
  const chain = await readChain({ rpcUrl: values.rpc, processor: values.processor, from: values.from });
  const plan = planTapeout({
    name: json.name,
    netlist: json,
    chain,
    expectChainId: values["chain-id"] === undefined ? undefined : parseCount(values["chain-id"], "--chain-id", { min: 1 }),
    expectImplementation: values["expect-implementation"],
  });

  let simulated = "not simulated";
  if (!values["skip-simulation"]) {
    let simulation;
    try {
      simulation = await simulatePlan({ rpcUrl: values.rpc, plan });
    } catch (error) {
      throw new Error(error.unsupported ? `${error.message}; use an RPC that supports it, or pass --skip-simulation` : error.message);
    }
    if (!simulation.ok) {
      console.error(`error: simulated at block ${plan.readAtBlock}, this plan would fail; nothing written`);
      simulation.calls.forEach((c, i) => console.error(`  ${i + 1}. ${c.purpose}: ${c.ok ? "ok" : c.error}`));
      for (const problem of simulation.problems) console.error(`  ${problem}`);
      return 2;
    }
    plan.simulation = simulation;
    simulated = `simulated ok: circuit id ${simulation.circuitId}, ${simulation.gasUsed} gas${simulation.senderToppedUp ? ", with the sender's balance topped up" : ""}`;
  }
  for (const warning of plan.warnings) console.error(`warning: ${warning}`);

  const text = `${JSON.stringify(plan, null, 2)}\n`;
  const line = `${plan.circuit.name}: ${plan.transactions.length} unsigned transactions, total value ${plan.totalValue} wei, expected circuit id ${plan.expectedCircuitId} (block ${plan.readAtBlock}); ${simulated}`;
  if (values.out) {
    writeFileSync(values.out, text);
    console.log(line);
    console.log(`  -> ${values.out}`);
  } else {
    process.stdout.write(text);
    console.error(line);
  }
});
