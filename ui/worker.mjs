// Compiles off the page's main thread: one job in, progress messages and one
// result out. The result carries the same three files the command line writes.
import { artifactFiles, compileSpec, composeSpec, composedFiles, netlistJson, tableJson, topJson } from "../src/job.mjs";

self.addEventListener("message", ({ data }) => {
  const { kind, spec, labels, name, steps, seed, objective, sentence, lang, compose } = data;
  let last = 0;
  const onProgress = (progress) => {
    const now = Date.now();
    if (progress.phase === "annealing" && now - last < 80) return;
    // Block compiles report their own annealing too; only the block count is worth showing.
    if (progress.phase === "annealing" && compose) return;
    last = now;
    self.postMessage({ type: "progress", ...progress });
  };
  try {
    // A program too wide for one proof, delivered as blocks: the person chose linked (one
    // circuit of REFs) or replay (the blocks and an order), and the same blocks serve both.
    if (compose) {
      const result = composeSpec(spec, { steps, seed, objective, onProgress });
      self.postMessage({
        type: "done",
        composed: true,
        compose,
        netlist: topJson(name, result.top),
        certificate: { name, ...result.certificate },
        files: composedFiles(name, result),
      });
      return;
    }
    const result = compileSpec(kind, spec, { labels, steps, seed, objective, onProgress });
    self.postMessage({
      type: "done",
      netlist: netlistJson(name, result.circuit),
      certificate: { name, ...result.certificate },
      table: tableJson(result.table),
      files: artifactFiles(name, result, { sentence, lang }),
    });
  } catch (error) {
    // Too wide for one circuit is not a dead end: the page offers to cut it into blocks.
    const wide = kind === "expr" && !compose ? /add up to (\d+) bits; every combination/.exec(error.message) : null;
    if (wide) self.postMessage({ type: "wide", bits: Number(wide[1]), message: error.message });
    else self.postMessage({ type: "error", message: error.message });
  }
});
