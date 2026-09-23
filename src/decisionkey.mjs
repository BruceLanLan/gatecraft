// Where this machine keeps the decision model's key. Read on every use rather than once at
// start, so writing the file does not need a restart, and never returned to anything that asks
// what the server holds - callers only ever learn "present" or "absent".
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function decisionKey() {
  const named = process.env.TYPESAFE_API_KEY?.trim();
  if (named) return named;
  try { return readFileSync(join(homedir(), ".config", "gatecraft", "jev.token"), "utf8").trim() || null; } catch { return null; }
}
