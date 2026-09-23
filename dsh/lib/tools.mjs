// The tools this plugin gives the harness's agent. Pure: it builds definitions from the
// engine and the harness's own defineTool, so the definitions can be checked without a
// harness running.
//
// The agent is the natural-language tier here. It writes the expression program itself,
// checks it with gatecraft_check, compiles it with gatecraft_compile, and the compiler proves
// the circuit on every input. No API key and no prompt copying: the model is already in the
// room.
import { METHODS } from "../../src/api.mjs";

const PROGRAM = {
  type: "object",
  required: true,
  description: 'The program: {"inputs":{"a":4},"state":{…},"outputs":{"y":{"width":4,"expr":"a + 1"}},"examples":[{"given":{"a":3},"expect":{"y":4}}]}. Inputs and state together at most 20 bits; each output is its value modulo 2^width.',
  additionalProperties: true,
};
const COMMON = {
  steps: { type: "number", description: "Annealing budget in steps; more means a smaller circuit and a longer wait." },
  seed: { type: "string", description: "Random seed, so a rerun gives the same bytes. Default: derived from the table." },
  objective: { type: "string", description: 'What to minimise: "gates" (default) or "cost" (PoD cost, which weighs depth).' },
};

const say = (text) => [{ type: "text", text }];

export function buildTools({ defineTool = (definition) => definition, api = METHODS } = {}) {
  const compile = defineTool({
    name: "gatecraft_compile",
    description: "Compile a behaviour into a NAND circuit and prove it on every input. Takes an expression program (see gatecraft_check first when unsure). Refuses to compile a program that contradicts its own examples.",
    parameters: { program: PROGRAM, name: { type: "string", description: "A short lowercase slug for the circuit." }, ...COMMON },
    output: {
      schema: {
        type: "object",
        properties: {
          nand: { type: "number" },
          latch: { type: "number" },
          depth: { type: "number" },
          rowsChecked: { type: "number" },
          wrong: { type: "number" },
          examplesHold: { type: "number" },
          netlistHex: { type: "string" },
          netlistSha256: { type: "string" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => say(`${value.nand} NAND${value.latch ? ` + ${value.latch} LATCH` : ""}, depth ${value.depth}; ${value.rowsChecked} of ${value.rowsChecked} rows match the program${value.examplesHold ? `, and ${value.examplesHold === 1 ? "its one example holds" : `all ${value.examplesHold} examples hold`}` : ""}.`),
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.();
      const out = await api["compile.expr"]({ spec: args.program, name: args.name, steps: args.steps, seed: args.seed, objective: args.objective });
      const c = out.certificate;
      return {
        nand: c.circuit.nand,
        latch: c.circuit.latch,
        depth: c.circuit.depth,
        rowsChecked: c.verification.rowsChecked,
        wrong: c.verification.wrong,
        examplesHold: c.expression?.examplesHold ?? 0,
        netlistHex: out.circuit.netlistHex,
        netlistSha256: c.circuit.netlistSha256,
      };
    },
  });

  const check = defineTool({
    name: "gatecraft_check",
    description: "Read a program back in plain words and check its own examples, without compiling. Use it to see whether a program says what was asked before spending a compile on it.",
    parameters: { program: PROGRAM, lang: { type: "string", description: 'Language of the read-back: "en" (default) or "zh".' } },
    output: {
      schema: {
        type: "object",
        properties: {
          nIn: { type: "number" },
          nState: { type: "number" },
          nOut: { type: "number" },
          rows: { type: "number" },
          readback: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          examplesTotal: { type: "number" },
          examplesHold: { type: "number" },
          failures: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      render: (_args, value) => say([...value.readback, ...value.warnings.map((w) => `warning: ${w}`),
        value.examplesTotal ? `${value.examplesHold} of ${value.examplesTotal} examples hold.` : "No examples yet; add a few worked out from the description.",
        ...value.failures].join("\n")),
    },
    async execute(args) {
      const out = await api["program.check"]({ spec: args.program, lang: args.lang });
      return {
        nIn: out.nIn,
        nState: out.nState,
        nOut: out.nOut,
        rows: out.rows,
        readback: out.explain.lines,
        warnings: out.explain.warnings,
        examplesTotal: out.examples.total,
        examplesHold: out.examples.hold,
        failures: out.examples.failures.map((f) => f.message),
      };
    },
  });

  const simulate = defineTool({
    name: "gatecraft_simulate",
    description: "Run a compiled circuit's netlist bytes on one set of inputs (and current state). This is the circuit itself, not the program.",
    parameters: {
      netlistHex: { type: "string", required: true, description: "The netlistHex a compile returned." },
      nIn: { type: "number", required: true },
      nOut: { type: "number", required: true },
      inputs: { type: "array", required: true, items: { type: "number" }, description: "One bit per input, least significant first." },
      state: { type: "array", items: { type: "number" }, description: "One bit per latch; all zero at power-on." },
    },
    output: {
      schema: {
        type: "object",
        properties: { outputs: { type: "array", items: { type: "number" } }, newState: { type: "array", items: { type: "number" } }, nand: { type: "number" }, latch: { type: "number" }, depth: { type: "number" } },
        additionalProperties: false,
      },
      render: (args, value) => say(`inputs ${args.inputs.join("")} -> outputs ${value.outputs.join("")}${value.latch ? `, next state ${value.newState.join("")}` : ""}`),
    },
    execute: (args) => api["circuit.simulate"](args),
  });

  return [compile, check, simulate];
}
