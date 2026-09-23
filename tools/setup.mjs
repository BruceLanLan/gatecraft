// One-time setup for a fresh clone. Run before the first commit: `npm run setup`.
//
// Nothing here travels with `git clone`: repository-local git identity and
// core.hooksPath live in .git/config, which is never cloned. Without this step
// a new clone commits under whatever global identity the machine has and pushes
// with no guard at all -- so the guard itself refuses to pass until this ran.
import { execSync } from "node:child_process";
import { existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

const sh = (cmd) => execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim();

sh('git config user.name "gatecraft"');
sh('git config user.email "gatecraft@noreply.local"');
sh("git config core.hooksPath .githooks");
chmodSync(".githooks/pre-push", 0o755);

// The banned-word list is machine-local and its contents are the secret. Never
// create a placeholder: an empty or invented list would make the guard pass
// while checking nothing.
const LIST = join(process.env.HOME ?? "", ".config", "gatecraft", "banned.txt");
if (!existsSync(LIST)) {
  console.error(`missing ${LIST}. It is not in the repository on purpose; get it from the repository owner. Do not create one yourself.`);
  process.exit(1);
}

execSync("node tools/assert_no_sensitive_info.mjs", { stdio: "inherit" });
console.log("setup done: neutral identity, pre-push guard active, banned list found");
