// Run the third-party proof, when Yosys is installed. Node-only: the browser never needs it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function yosysAvailable() {
  const probe = spawnSync("yosys", ["-V"], { encoding: "utf8" });
  return !probe.error && probe.status === 0 ? probe.stdout.trim() : null;
}

// Writes the files into a scratch directory, runs the script, cleans up. `proven` is true
// only when Yosys exits 0 AND reports the SAT proof succeeded; the log is returned whole so a
// failure can be read, and the differing input Yosys prints is left in it.
export function proveWithYosys(files, { script = "equiv.ys", timeoutMs = 120_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gatecraft-yosys-"));
  try {
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    const run = spawnSync("yosys", ["-Q", "-T", "-s", script], { cwd: dir, encoding: "utf8", timeout: timeoutMs });
    const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    if (run.error) return { proven: false, ran: false, log: String(run.error.message) };
    const success = run.status === 0 && /SAT proof finished - no model found: SUCCESS/i.test(log);
    return { proven: success, ran: true, status: run.status, log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
