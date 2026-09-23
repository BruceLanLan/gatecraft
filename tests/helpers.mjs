import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const tempDir = (prefix = "gatecraft-test-") => mkdtempSync(join(tmpdir(), prefix));

export function runScript(script, args = [], { cwd = ROOT, env = process.env } = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { cwd, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Direct evaluation of a netlist in the synthesis form used by src/rebuild.mjs:
// one packed output value per (input, state) row.
export function tableOf({ nIn, nLatch = 0, gates, outputs }) {
  const bits = nIn + nLatch;
  const gate0 = 2 + bits;
  const ys = new Uint32Array(2 ** bits);
  const sig = new Uint8Array(gate0 + gates.length);
  sig[1] = 1;
  for (let r = 0; r < ys.length; r++) {
    for (let i = 0; i < bits; i++) sig[2 + i] = (r >>> i) & 1;
    for (let i = 0; i < gates.length; i++) sig[gate0 + i] = sig[gates[i][0]] & sig[gates[i][1]] ? 0 : 1;
    let y = 0;
    outputs.forEach((s, k) => { y |= sig[s] << k; });
    ys[r] = y >>> 0;
  }
  return ys;
}
