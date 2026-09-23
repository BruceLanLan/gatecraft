// One compile job, shared by the command line and the browser UI: a spec in the
// form a person wrote it in, the table, circuit and certificate out. Nothing
// here touches the file system, so it runs unchanged in a Web Worker.
//
//   kind "table"  spec for combinationalTable()
//   kind "grid"   spec for gridTable(); `labels` names choices 0..3
//   kind "fsm"    spec for fsmTable()
//   kind "expr"   named, sized inputs and outputs written as expressions (expr.mjs)
import { appHtml } from "./appexport.mjs";
import { blifNames, toBlif } from "./blif.mjs";
import { firstoImportText } from "./handoff.mjs";
import { compileTable } from "./compile.mjs";
import { describeFailure, exampleFailures, ExprError, parseProgram, programFromFn, programTable } from "./expr.mjs";
import { OPCODE } from "./netlist.mjs";
import { composeSpec, replayManifest } from "./compose.mjs";
import { booleanIrFiles } from "./boolean-ir.mjs";
import { codebookJson, decisionPinNames, reviewRows } from "./decision.mjs";
import { buildStructural, NotStructural } from "./structural.mjs";
import { combinationalTable, fsmTable, gridTable, reachableStates } from "./tables.mjs";

export const NETLIST_FORMAT = "gatecraft.netlist/1";
export const KINDS = ["table", "grid", "fsm", "expr"];

// A structural compilation of a program, offered to compileTable as a starting point. A
// program this front end does not build (NotStructural) simply offers none.
function structuralCandidates(program) {
  if (!program) return [];
  try {
    const { gates, outputs } = buildStructural(program);
    return [{ frontEnd: "expression", gates, outputs }];
  } catch (error) {
    if (error instanceof NotStructural) return [];
    throw error;
  }
}

export function netlistJson(name, circuit) {
  return {
    format: NETLIST_FORMAT,
    name,
    nIn: circuit.nIn,
    nOut: circuit.nOut,
    nState: circuit.nLatch,
    nand: circuit.nNand,
    latch: circuit.nLatch,
    depth: circuit.depth,
    netlistBytes: circuit.netlistBytes,
    netlistHex: circuit.netlistHex,
    elements: circuit.elements.map((e) => (e.op === OPCODE.LATCH ? ["LATCH", e.d] : ["NAND", e.a, e.b])),
  };
}

// A composed result as files: the top circuit (REFs still pointing at block indexes until
// linkTop fills in deployed ids), one netlist and certificate per block, the replay manifest
// for the unlinked delivery, and the certificate that ties them together.
export function composedFiles(name, result) {
  const files = {
    "top.netlist.json": `${JSON.stringify(topJson(name, result.top), null, 1)}\n`,
    "compose.certificate.json": `${JSON.stringify({ name, ...result.certificate }, null, 2)}\n`,
    "replay.json": `${JSON.stringify(replayManifest(result), null, 1)}\n`,
  };
  for (const b of result.blocks) {
    files[`block-${b.index}.netlist.json`] = `${JSON.stringify(netlistJson(`${name}-block-${b.index}`, b.circuit), null, 1)}\n`;
    files[`block-${b.index}.certificate.json`] = `${JSON.stringify({ name: `${name}-block-${b.index}`, ...b.certificate }, null, 2)}\n`;
    files[`block-${b.index}.firsto.json`] = firstoImportText(b.circuit);
  }
  return files;
}

export function topJson(name, top) {
  return {
    format: NETLIST_FORMAT,
    name,
    nIn: top.nIn,
    nOut: top.nOut,
    nState: top.nLatch,
    nand: 0,
    latch: top.nLatch,
    refs: top.elements.filter((e) => e.op === OPCODE.REF).length,
    netlistBytes: top.netlistBytes,
    netlistHex: top.netlistHex,
    elements: top.elements.map((e) => (e.op === OPCODE.LATCH ? ["LATCH", e.d] : ["REF", String(e.cpu), String(e.circuitId), e.inputs, e.nOut])),
  };
}

export { composeSpec, replayManifest };

// A frozen decision as files: the codebook (the contract), the fill (where every answer came
// from), the rows a person should still look at, the circuit with its certificate, and the
// Boolean IR pair with the Yosys script that proves them equal without this compiler.
export function decisionFiles(frozen) {
  const d = frozen.decision;
  const names = decisionPinNames(d);
  const ir = booleanIrFiles(d.name, frozen, { names });
  return {
    "codebook.json": `${JSON.stringify(codebookJson(d), null, 2)}\n`,
    "fill.json": `${JSON.stringify(frozen.fill, null, 0)}\n`,
    "review.json": `${JSON.stringify({ codebook: d.codebookSha256, threshold: d.threshold, howTo: "copy a row into overrides.json as { given, choice } to confirm or change it, then freeze again", rows: reviewRows(d, frozen.fill) }, null, 1)}\n`,
    "circuit.netlist.json": `${JSON.stringify(netlistJson(d.name, frozen.circuit), null, 1)}\n`,
    "circuit.certificate.json": `${JSON.stringify({ name: d.name, ...frozen.certificate }, null, 2)}\n`,
    "circuit.firsto.json": firstoImportText(frozen.circuit),
    ...ir,
  };
}

export const tableJson = (table) => ({ nIn: table.nIn, nState: table.nState ?? 0, nOut: table.nOut, ys: [...table.ys] });

// The three files a compile leaves behind, as text, byte for byte what the
// command line writes to out/NAME/.
export function artifactFiles(name, { circuit, certificate, table }, { sentence = "", lang = "en" } = {}) {
  return {
    "circuit.netlist.json": `${JSON.stringify(netlistJson(name, circuit), null, 1)}\n`,
    "circuit.certificate.json": `${JSON.stringify({ name, ...certificate }, null, 2)}\n`,
    "table.json": `${JSON.stringify(tableJson(table))}\n`,
    // The same circuit as a netlist a fab's tools read (tapeout.net's canvas imports it and
    // burns it with the user's own wallet), so getting a real chip needs nothing from here.
    "circuit.blif": toBlif(circuit, { name, names: blifNames(certificate.expression) }),
    // One file for tapeout.firsto.ai's flow import: the canonical bytes with nIn and nOut, so
    // nothing is typed by hand over there.
    "circuit.firsto.json": firstoImportText(circuit),
    // The circuit as something a person can use: one self-contained page, no server.
    "app.html": appHtml({ name, sentence, lang, netlist: netlistJson(name, circuit), certificate: { compiler: certificate.compiler, circuit: certificate.circuit, verification: certificate.verification, reproduce: certificate.reproduce }, expression: certificate.expression }),
  };
}

export function compileSpec(kind, spec, { labels = ["0", "1", "2", "3"], steps, seed, objective, onProgress } = {}) {
  if (kind === "table") {
    const table = combinationalTable(spec);
    // An fn the expression language can read also gets a structural start. The table itself
    // was evaluated as JavaScript; the candidate is kept only if it matches that table on
    // every row, so a difference in semantics can cost a candidate but never a wrong circuit.
    const candidates = spec.fn !== undefined ? structuralCandidates(programFromFn(spec.fn, table.nIn, table.nOut)) : [];
    return { table, ...compileTable(table, { steps, seed, objective, onProgress, candidates }) };
  }
  if (kind === "expr") {
    const program = parseProgram(spec);
    // A program that contradicts its own examples says something other than what was meant:
    // refuse it before spending a compile on it.
    const failures = exampleFailures(program);
    if (failures.length) {
      throw new ExprError(`${failures.length} of ${program.examples.length} examples do not hold, so nothing was compiled; ${describeFailure(failures[0])}`);
    }
    const table = programTable(program);
    const result = compileTable(table, { steps, seed, objective, onProgress, candidates: structuralCandidates(program) });
    let bit = 0;
    const place = (items) => items.map(({ name, width }) => {
      const at = width === 1 ? `bit ${bit}` : `bits ${bit}-${bit + width - 1}`;
      bit += width;
      return { name, width, at };
    });
    const inputs = place(program.inputs);
    bit = 0;
    const state = place(program.states);
    bit = 0;
    const outputs = place(program.outputs);
    if (program.nState) {
      const reachable = reachableStates(table);
      result.certificate.stateMachine = {
        stateBits: "state bit i is latch i; the state values are packed least significant bit first, in declaration order",
        startState: 0,
        reachableFromStart: reachable.length,
        unreachableStates: 2 ** table.nState - reachable.length,
      };
    }
    result.certificate.expression = {
      inputs,
      ...(program.nState ? { state } : {}),
      outputs,
      packing: "least significant bit first, in declaration order",
      semantics: "exact integers; each output is its value modulo 2^width",
      ...(program.examples.length ? { examplesHold: program.examples.length } : {}),
    };
    return { table, program, ...result };
  }
  if (kind === "grid") {
    if (!Array.isArray(labels) || labels.length !== 4 || labels.some((s) => typeof s !== "string" || !s)) throw new Error("labels needs four non-empty names");
    const { table, counts } = gridTable(spec);
    const result = compileTable(table, { steps, seed, objective, onProgress });
    result.certificate.grid = {
      inputs: { X: "bits 0-3", Y: "bits 4-7" },
      choices: Object.fromEntries(labels.map((label, k) => [label, counts[k]])),
      neverChosen: labels.filter((_, k) => counts[k] === 0),
    };
    return { table, counts, ...result };
  }
  if (kind === "fsm") {
    const table = fsmTable(spec);
    const result = compileTable(table, { steps, seed, objective, onProgress });
    const reachable = reachableStates(table);
    result.certificate.stateMachine = {
      stateBits: "state bit i is latch i, in declaration order",
      startState: 0,
      reachableFromStart: reachable.length,
      unreachableStates: 2 ** table.nState - reachable.length,
    };
    return { table, reachable, ...result };
  }
  throw new Error(`kind must be one of ${KINDS.join(", ")}`);
}
