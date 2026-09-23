// Refuses to let this repository carry any trace of where it came from or who
// made it. The word list itself lives OUTSIDE the repository
// (~/.config/gatecraft/banned.txt, one lowercase substring per line), because a
// list of the things that must never appear here must never appear here either.
// Missing list = refuse, never "pass".
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
const LIST = join(process.env.HOME ?? "", ".config", "gatecraft", "banned.txt");
if (!existsSync(LIST)) { console.error(`no banned-word list at ${LIST}; refusing`); process.exit(1); }
const BANNED = readFileSync(LIST, "utf8").split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean);
if (BANNED.length < 5) { console.error("banned-word list looks empty; refusing"); process.exit(1); }
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); if (f === ".git" || f === "node_modules" || f === "out") return []; return statSync(p).isDirectory() ? walk(p) : [p]; });
let bad = 0;
for (const p of walk(".")) {
  const t = readFileSync(p, "utf8").toLowerCase();
  for (let i = 0; i < BANNED.length; i++) if (t.includes(BANNED[i])) { console.error(`${p}: contains banned entry #${i + 1}`); bad++; }
}
// commits too: authors, committers and full messages (trailers live in the body)
const log = execSync("git log --format='%an <%ae> %cn <%ce> %B'", { encoding: "utf8" }).toLowerCase();
for (let i = 0; i < BANNED.length; i++) if (log.includes(BANNED[i])) { console.error(`git history contains banned entry #${i + 1}`); bad++; }
// tool-added session links say what wrote this; none belong here (co-author trailers are on the list)
for (const t of ["session:", "claude.ai/", "generated with"]) if (log.includes(t)) { console.error(`git history contains a trailer or session link ("${t}")`); bad++; }
const cfg = (k) => { try { return execSync(`git config ${k}`, { encoding: "utf8" }).trim(); } catch { return ""; } };
if (!/^gatecraft/.test(cfg("user.name")) || !/noreply/.test(cfg("user.email"))) { console.error("git identity is not the neutral one (run `npm run setup`)"); bad++; }
// local config is not cloned: without this a fresh clone pushes with no guard at all
if (cfg("core.hooksPath") !== ".githooks") { console.error("pre-push guard is not active (run `npm run setup`)"); bad++; }
if (bad) { console.error(`${bad} problems`); process.exit(1); }
console.log("clean");
