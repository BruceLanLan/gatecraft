// The pre-push guard must refuse in every situation where it would otherwise
// check nothing, or check the wrong thing. Each case runs in a throwaway git
// repository with a throwaway HOME, so the real word list is never read here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT, tempDir } from "./helpers.mjs";

// Nonsense stand-ins for the private list.
const FAKE_LIST = ["qxzvbnm-one", "qxzvbnm-two", "qxzvbnm-three", "qxzvbnm-four", "qxzvbnm-five"];

function makeRepo({ list = FAKE_LIST, neutral = true, hooks = true, file = "nothing to see\n", message = "first" } = {}) {
  const home = tempDir("gatecraft-home-");
  if (list) {
    mkdirSync(join(home, ".config", "gatecraft"), { recursive: true });
    writeFileSync(join(home, ".config", "gatecraft", "banned.txt"), `${list.join("\n")}\n`);
  }
  const repo = tempDir("gatecraft-repo-");
  mkdirSync(join(repo, "tools"));
  mkdirSync(join(repo, ".githooks"));
  for (const f of ["tools/assert_no_sensitive_info.mjs", "tools/setup.mjs", ".githooks/pre-push"]) copyFileSync(join(ROOT, f), join(repo, f));
  writeFileSync(join(repo, "notes.txt"), file);
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", neutral ? "gatecraft" : "someone");
  git("config", "user.email", neutral ? "gatecraft@noreply.local" : "someone@example.com");
  if (hooks) git("config", "core.hooksPath", ".githooks");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  return { repo, env };
}

const guard = ({ repo, env }) => spawnSync(process.execPath, ["tools/assert_no_sensitive_info.mjs"], { cwd: repo, env, encoding: "utf8" });

test("guard passes a clean repository with the neutral identity and the hook", () => {
  const r = guard(makeRepo());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean/);
});

test("guard refuses when the word list is missing", () => {
  const r = guard(makeRepo({ list: null }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing/);
});

test("guard refuses a word list that is too short to mean anything", () => {
  assert.equal(guard(makeRepo({ list: FAKE_LIST.slice(0, 3) })).status, 1);
});

test("guard refuses when the git identity is not the neutral one", () => {
  const r = guard(makeRepo({ neutral: false }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /identity/);
});

test("guard refuses when the pre-push hook is not active", () => {
  const r = guard(makeRepo({ hooks: false }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pre-push/);
});

test("guard refuses a file that contains a listed word", () => {
  const r = guard(makeRepo({ file: `a line with ${FAKE_LIST[2].toUpperCase()} in it\n` }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /banned entry #3/);
});

test("guard refuses a commit message carrying a tool trailer", () => {
  const trailer = ["Tool-Sess", "ion: 1"].join("");
  const r = guard(makeRepo({ message: `subject\n\n${trailer}` }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git history/);
});

test("setup refuses when the word list is missing", () => {
  const ctx = makeRepo({ list: null });
  const r = spawnSync(process.execPath, ["tools/setup.mjs"], { cwd: ctx.repo, env: ctx.env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Do not create one yourself/);
});
