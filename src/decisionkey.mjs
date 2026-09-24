// Where this machine keeps the decision model's key. Read on every use rather than once at
// start, so writing the file does not need a restart, and never returned to anything that asks
// what the server holds - callers only ever learn "present" or "absent".
//
// The page run locally can also write it here for you (key.save), so nobody has to open
// a terminal - or know that `printf` does not exist on Windows - to get started.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const keyDir = () => join(homedir(), ".config", "gatecraft");
const keyFile = (dir) => join(dir, "jev.token");

export function decisionKey({ dir = keyDir() } = {}) {
  const named = process.env.TYPESAFE_API_KEY?.trim();
  if (named) return named;
  try { return readFileSync(keyFile(dir), "utf8").trim() || null; } catch { return null; }
}

export function saveDecisionKey(key, { dir = keyDir() } = {}) {
  const clean = String(key ?? "").trim();
  if (clean.length < 8 || clean.length > 400 || /\s/.test(clean)) throw new Error("that does not look like an API key: paste the whole key, with no spaces or line breaks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile(dir), clean, { mode: 0o600 });
  try { chmodSync(keyFile(dir), 0o600); } catch { /* Windows: permissions are the user's profile folder's */ }
  return { file: keyFile(dir), overriddenByEnv: Boolean(process.env.TYPESAFE_API_KEY?.trim()) };
}

export function forgetDecisionKey({ dir = keyDir() } = {}) {
  rmSync(keyFile(dir), { force: true });
  return { file: keyFile(dir), overriddenByEnv: Boolean(process.env.TYPESAFE_API_KEY?.trim()) };
}
