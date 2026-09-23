// Shared command-line plumbing for the scripts in scripts/.
import { join } from "node:path";
import { parseSeed } from "./rng.mjs";

export const commonOptions = {
  name: { type: "string" },
  out: { type: "string" },
  steps: { type: "string" },
  seed: { type: "string" },
  objective: { type: "string" },
  help: { type: "boolean", short: "h" },
};

export function parseCount(value, flag, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) throw new Error(`${flag} is required`);
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${flag} must be an integer ${min}..${max}, got "${value}"`);
  }
  return Number(value);
}

export function parseCommon(values) {
  const name = values.name;
  if (!name || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) throw new Error("--name must be a short lowercase slug, e.g. --name majority3");
  return {
    name,
    out: values.out ?? join("out", name),
    steps: values.steps === undefined ? undefined : parseCount(values.steps, "--steps", { min: 1, max: 1e9 }),
    seed: values.seed === undefined ? undefined : parseSeed(values.seed),
    objective: values.objective === undefined ? undefined : parseObjective(values.objective),
  };
}

function parseObjective(value) {
  if (value !== "gates" && value !== "cost") throw new Error(`--objective must be gates or cost, got "${value}"`);
  return value;
}

export async function run(usage, main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage.trim());
    return;
  }
  try {
    const code = await main();
    if (Number.isInteger(code)) process.exitCode = code;
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

export function summary(name, { circuit, certificate }, files) {
  const c = certificate.circuit;
  const latch = c.latch ? ` + ${c.latch} LATCH` : "";
  console.log(`${name}: ${c.nand} NAND${latch}, depth ${c.depth}, ${c.netlistBytes} bytes; ${certificate.verification.rowsChecked}/${certificate.verification.rowsChecked} rows exact (seed ${certificate.reproduce.seed}, ${certificate.reproduce.steps} steps${certificate.reproduce.objective === "cost" ? ", cost objective" : ""})`);
  console.log(`  -> ${files.netlist}`);
  console.log(`  -> ${files.certificate}`);
  return circuit;
}
