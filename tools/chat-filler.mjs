// Filling a decision's table with an ordinary chat model, when the typed decision model is
// not reachable.
//
// This is NOT the same instrument as `jevFiller`. Jev returns a calibrated probability over a
// declared set of choices; a chat model returns a number it wrote itself in a JSON object. The
// whole review mechanism keys off that number, so anything measured through this filler has to
// carry the model's name and must not be compared against the Jev runs in jev-table.md.
//
// One process per situation through the local `opencode` CLI, because that is the route this
// machine has to these models. It is slow (~8s a call) and CPU-heavy, so every tool that uses
// it takes a hard cap on the number of calls and prints what it actually spent.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askText, lastJson, majorityFiller, spread, strip } from "../src/chatfill.mjs";

// The pure parts moved to src/chatfill.mjs so the page can share them; re-exported so every
// caller of this file keeps working unchanged.
export { askText, majorityFiller, spread };

// Where the CLI lives on this machine, without writing anyone's home directory into the repo.
export const opencodeBin = () => {
  const named = process.env.GATECRAFT_OPENCODE?.trim();
  if (named) return named;
  const installed = join(homedir(), ".opencode", "bin", "opencode");
  return existsSync(installed) ? installed : "opencode";
};

// A budget shared by every filler in one run, so a loop cannot quietly spend three times what
// the command line allowed.
export function budget(maxCalls) {
  let used = 0;
  return {
    take() {
      if (used >= maxCalls) throw new Error(`call budget of ${maxCalls} is spent`);
      used += 1;
      return used;
    },
    get used() { return used; },
    get left() { return maxCalls - used; },
  };
}


export function runOpencode(model, prompt, { cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(opencodeBin(), ["run", "--dir", cwd, "--model", model, prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}: ${strip(err).slice(0, 120)}`));
      else resolve(out);
    });
  });
}

// The question, said the way a person would say it. The model is shown the scene, the
// situation in the codebook's own words, and the choices - never a bit, never a code.
// A filler in the shape `fillDecision` wants: (codes, situation, d) -> { choice, confidence }.
// `scene` overrides the decision's own scene, which is what the scene-rewrite loop varies.
export function chatFiller(d, { model, cwd, scene = null, spend, retries = 2, source = "chat", run = runOpencode }) {
  const names = new Set(d.choices.map((c) => c.choice));
  return async (codes, situation) => {
    let last = null;
    for (let go = 0; go <= retries; go++) {
      spend.take();
      try {
        const answer = lastJson(await run(model, askText(d, situation, scene), { cwd }));
        if (!answer) throw new Error("no JSON object with a choice in the reply");
        if (!names.has(answer.choice)) throw new Error(`choice ${JSON.stringify(answer.choice)} is not one of the declared choices`);
        const confidence = Number(answer.confidence);
        if (!(confidence >= 0 && confidence <= 1)) throw new Error(`confidence ${JSON.stringify(answer.confidence)} is not 0..1`);
        return { choice: answer.choice, confidence, source, model };
      } catch (error) {
        last = error;
        if (spend.left <= 0) break;
      }
    }
    throw last ?? new Error("no attempt was made");
  };
}

