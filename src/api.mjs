// The local API: the compiler as a service for other programs on this machine.
//
// One endpoint, POST /api, with a dotted method name and JSON params - the shape the local
// tooling on this machine already speaks:
//
//   { "method": "compile.expr", "params": { "spec": { … }, "name": "vote" } }
//   -> { "ok": true, "method": "compile.expr", "result": { … } }
//   -> { "ok": false, "method": "compile.expr", "error": { "code": "failed", "message": "…" } }
//
// The server binds 127.0.0.1, checks the Host header and refuses a browser Origin from
// anywhere else (so another site cannot point its own name at this port), and takes an
// optional shared token. It holds no keys and calls no model: describe.prompt writes the
// prompt text, describe.read reads a model's answer back, and whatever asks the model does so
// on its own account. tapeout.plan reads the chain the caller names and returns unsigned
// transactions; nothing here ever signs or sends one.
import { atThreshold, calibrateThreshold, codebookJson, decodeRow, fillDecision, freezeDecision, isLegal, jevFiller, parseDecision, reviewRows, ruleFiller } from "./decision.mjs";
import { drawAnchors } from "./anchors.mjs";
import { startTrial, trialStatus, trialUrl } from "./trial.mjs";
import { readBack, reviewDraft } from "./draft.mjs";
import { decisionModule } from "./decisionexport.mjs";
import { appHtml, SKINS } from "./appexport.mjs";
import { blifNames, toBlif } from "./blif.mjs";
import { chainCheck } from "./chaincheck.mjs";
import { PROVIDERS, describePrompt, questionFromReply, specFromReply } from "./describe.mjs";
import { FIRSTO_FLOW_URL, FIRSTO_PROCESSORS, firstoImport } from "./handoff.mjs";
import { explainProgram, sampleRows } from "./explain.mjs";
import { describeFailure, exampleFailures, parseProgram, programTable, runStep } from "./expr.mjs";
import { artifactFiles, compileSpec, netlistJson, tableJson } from "./job.mjs";
import { decodeCircuit, hexToBytes, simulate } from "./netlist.mjs";
import { parseSeed } from "./rng.mjs";
import { planTapeout, readChain, simulatePlan } from "./tapeout.mjs";
import { COMPILER, OBJECTIVES } from "./compile.mjs";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A compile runs while the request is open, so the budget a caller may ask for is capped.
export const MAX_STEPS = 5_000_000;

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}
const bad = (message) => new ApiError("bad_request", message);

const asObject = (value, what) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad(`"${what}" must be an object`);
  return value;
};
const asString = (value, what) => {
  if (typeof value !== "string" || !value.trim()) throw bad(`"${what}" must be a non-empty string`);
  return value;
};

function compileOptions(params) {
  const options = {};
  if (params.steps !== undefined) {
    if (!Number.isInteger(params.steps) || params.steps < 1 || params.steps > MAX_STEPS) throw bad(`"steps" must be a whole number 1..${MAX_STEPS}`);
    options.steps = params.steps;
  }
  if (params.seed !== undefined) {
    try {
      options.seed = parseSeed(String(params.seed));
    } catch (error) {
      throw bad(error.message);
    }
  }
  if (params.objective !== undefined) {
    if (!OBJECTIVES.includes(params.objective)) throw bad(`"objective" must be one of ${OBJECTIVES.join(", ")}`);
    options.objective = params.objective;
  }
  return options;
}

const NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;

// One compile, as the command line and the page do it. `files` adds the three artifact files
// as text, byte for byte what `out/NAME/` would hold.
function compile(kind, params) {
  const spec = kind === "grid" && Array.isArray(params.spec) ? { map: params.spec } : asObject(params.spec, "spec");
  const name = params.name === undefined ? kind : asString(params.name, "name");
  if (!NAME.test(name)) throw bad('"name" must be a short lowercase slug, e.g. "vote"');
  const options = compileOptions(params);
  if (kind === "grid" && params.labels !== undefined) {
    if (!Array.isArray(params.labels) || params.labels.length !== 4 || params.labels.some((s) => typeof s !== "string" || !s)) throw bad('"labels" must be four non-empty names');
    options.labels = params.labels;
  }
  let result;
  try {
    result = compileSpec(kind, spec, options);
  } catch (error) {
    throw new ApiError("failed", error.message);
  }
  const out = {
    name,
    circuit: netlistJson(name, result.circuit),
    certificate: { name, ...result.certificate },
  };
  if (params.table === true) out.table = tableJson(result.table);
  if (params.files === true) out.files = artifactFiles(name, result);
  return out;
}

function checked(spec) {
  try {
    return parseProgram(asObject(spec, "spec"));
  } catch (error) {
    throw new ApiError("failed", error.message);
  }
}

export const MAX_FILL_ROWS = 4096;

export const METHODS = {
  // What this server is and what it answers.
  "health.status": (_params, { methods = METHODS, plugins = [], decisionKey = null, keyStore = null } = {}) => ({
    canSaveKey: Boolean(keyStore),
    compiler: COMPILER,
    methods: Object.keys(methods),
    ...(plugins.length ? { plugins } : {}),
    maxSteps: MAX_STEPS,
    maxBodyBytes: MAX_BODY_BYTES,
    holdsKeys: false,
    // holdsKeys stays false: nothing a caller sends is kept. This is different and is said
    // separately - whether the machine's OWN decision-model key is readable by this server, so
    // the page can fill a table without the key ever entering a browser.
    decisionKey: decisionKey ? "present" : "absent",
    signsTransactions: false,
  }),

  // An expression program without compiling it: widths, its own examples, and the read-back.
  "program.check": ({ spec, lang = "en" }) => {
    const program = checked(spec);
    const failures = exampleFailures(program);
    return {
      nIn: program.nIn,
      nState: program.nState,
      nOut: program.nOut,
      rows: 2 ** (program.nIn + program.nState),
      inputs: program.inputs.map(({ name, width }) => ({ name, width })),
      state: program.states.map(({ name, width }) => ({ name, width })),
      outputs: program.outputs.map(({ name, width }) => ({ name, width })),
      examples: { total: program.examples.length, hold: program.examples.length - failures.length, failures: failures.map((f) => ({ index: f.index, given: f.given, expect: f.expect, then: f.then, got: f.got, gotNext: f.gotNext, message: describeFailure(f) })) },
      explain: explainProgram(program, lang === "zh" ? "zh" : "en"),
      samples: sampleRows(program),
    };
  },

  // The program's own answer for named input (and current state) values.
  "program.run": ({ spec, given = {} }) => {
    const program = checked(spec);
    const values = asObject(given, "given");
    for (const name of Object.keys(values)) {
      if (![...program.inputs, ...program.states].some((f) => f.name === name)) throw bad(`"${name}" is not an input or state value`);
      if (!Number.isInteger(values[name]) || values[name] < 0) throw bad(`"${name}" must be a whole number 0 or more`);
    }
    const step = runStep(program, values);
    return { outputs: step.outputs, next: step.next };
  },

  // Every row of the table a program denotes, as the compiler would build it.
  "program.table": ({ spec }) => {
    const program = checked(spec);
    if (2 ** (program.nIn + program.nState) > 1 << 16) throw new ApiError("failed", "the table has more than 65,536 rows; compile it instead");
    return tableJson(programTable(program));
  },

  "compile.expr": (params) => compile("expr", params),
  "compile.table": (params) => compile("table", params),
  "compile.grid": (params) => compile("grid", params),
  "compile.fsm": (params) => compile("fsm", params),

  // A compiled circuit, run on one input (and state): what the netlist bytes really do.
  "circuit.simulate": ({ netlistHex, nIn, nOut, inputs, state = [], signals = false }) => {
    asString(netlistHex, "netlistHex");
    if (!Number.isInteger(nIn) || nIn < 0 || !Number.isInteger(nOut) || nOut < 1) throw bad('"nIn" and "nOut" must be whole numbers');
    if (!Array.isArray(inputs) || inputs.length !== nIn || inputs.some((b) => b !== 0 && b !== 1)) throw bad(`"inputs" must be ${nIn} bits, each 0 or 1`);
    if (!Array.isArray(state) || state.some((b) => b !== 0 && b !== 1)) throw bad('"state" must be bits, each 0 or 1');
    let circuit;
    try {
      circuit = decodeCircuit(hexToBytes(netlistHex), nIn, nOut);
    } catch (error) {
      throw new ApiError("failed", `netlistHex does not decode: ${error.message}`);
    }
    if (state.length !== circuit.nLatch) throw bad(`"state" must be ${circuit.nLatch} bits for this circuit`);
    let step;
    try {
      step = simulate(circuit, inputs, Uint8Array.from(state));
    } catch (error) {
      throw new ApiError("failed", error.message);
    }
    return {
      outputs: [...step.outputs],
      newState: [...step.newState],
      nand: circuit.nNand,
      latch: circuit.nLatch,
      depth: circuit.depth,
      ...(signals === true ? { signals: [...step.signals] } : {}),
    };
  },

  // The prompt a person or a program pastes into whatever model it pays for, and reading the
  // answer back. No key is ever sent here, and this server calls no model.
  "describe.prompt": ({ sentence }) => {
    try {
      return { prompt: describePrompt(asString(sentence, "sentence")), providers: Object.keys(PROVIDERS) };
    } catch (error) {
      throw error instanceof ApiError ? error : new ApiError("failed", error.message);
    }
  },
  "describe.read": ({ reply }) => {
    asString(reply, "reply");
    const question = questionFromReply(reply);
    if (question) return { question };
    let spec;
    try {
      spec = specFromReply(reply);
    } catch (error) {
      throw new ApiError("failed", error.message);
    }
    const program = checked(spec);
    const failures = exampleFailures(program);
    return { spec, examples: { total: program.examples.length, hold: program.examples.length - failures.length, failures: failures.map(describeFailure) } };
  },

  // The circuit as BLIF, which a fab's own tools read: the short way to a real chip is to
  // hand this file to whoever burns it (tapeout.net's canvas imports it directly).
  "circuit.blif": ({ netlistHex, nIn, nOut, name = "circuit", expression = null }) => {
    asString(netlistHex, "netlistHex");
    if (!Number.isInteger(nIn) || nIn < 0 || !Number.isInteger(nOut) || nOut < 1) throw bad('"nIn" and "nOut" must be whole numbers');
    let circuit;
    try {
      circuit = decodeCircuit(hexToBytes(netlistHex), nIn, nOut);
    } catch (error) {
      throw new ApiError("failed", `netlistHex does not decode: ${error.message}`);
    }
    return { blif: toBlif(circuit, { name, names: expression ? blifNames(expression) : null }), nand: circuit.nNand, latch: circuit.nLatch };
  },

  // A compiled circuit as one self-contained page: the circuit as something to use, and to
  // send to someone who will never see this API.
  "circuit.app": ({ netlist, certificate, sentence = "", skin = "auto", lang = "en" }) => {
    asObject(netlist, "netlist");
    asObject(certificate, "certificate");
    if (!SKINS.includes(skin)) throw bad(`"skin" must be one of ${SKINS.join(", ")}`);
    try {
      return { html: appHtml({ name: netlist.name ?? "circuit", sentence, skin, lang, netlist, certificate, expression: certificate.expression }) };
    } catch (error) {
      throw new ApiError("failed", error.message);
    }
  },

  // The file a fab's own flow imports. "firsto" is the flow-import envelope for
  // tapeout.firsto.ai (canonical bytes plus nIn and nOut); "blif" is the generic netlist.
  "circuit.handoff": ({ netlistHex, nIn, nOut, target = "firsto", processor = "TapeOut" }) => {
    if (target === "blif") return METHODS["circuit.blif"]({ netlistHex, nIn, nOut });
    if (target !== "firsto") throw bad('"target" must be "firsto" or "blif"');
    try {
      return { envelope: firstoImport({ netlistHex, nIn, nOut, processor }), flowUrl: FIRSTO_FLOW_URL, processors: FIRSTO_PROCESSORS };
    } catch (error) {
      throw bad(error.message);
    }
  },

  // Does the chain compute what this circuit computes? Reads a taped-out circuit and compares
  // the chain's own eval/step with simulate() here. Read-only: nothing is signed or sent.
  "chain.check": async ({ rpc, circuits, id, rows = 24, netlistHex = null }) => {
    const rpcUrl = asString(rpc, "rpc");
    if (!/^https?:\/\//i.test(rpcUrl)) throw bad('"rpc" must start with http:// or https://');
    asString(circuits, "circuits");
    if (id === undefined || id === null || `${id}`.trim() === "") throw bad('"id" is the circuit number on that contract');
    if (!Number.isInteger(rows) || rows < 1 || rows > 256) throw bad('"rows" must be a whole number 1..256');
    try {
      return await chainCheck({ rpcUrl, circuits, id, rows, netlistHex });
    } catch (error) {
      throw new ApiError("failed", error.message);
    }
  },

  // An unsigned tape-out plan for a compiled circuit: this reads the chain the caller names
  // and returns transactions for the caller to check and sign elsewhere.
  // ---------------------------------------------------------------- decisions
  //
  // The browser cannot call the decision model itself: its replies carry no
  // access-control-allow-origin, so a page fetch is blocked. That turned out to be the better
  // shape anyway - this server fills the table using the key sitting in the machine's own
  // config, and the key never enters a browser at all.

  // A codebook read back in plain words, plus what a person should look at before spending.
  "decision.review": ({ spec }) => {
    const { decision, legal, rows, notes } = reviewDraft(spec);
    return { text: readBack(spec), legal, rows, notes, codebook: codebookJson(decision) };
  },

  // Answer every legal situation. `rule` asks nobody; otherwise the decision model does.
  // With no key on this machine, one of the free fills is used instead - the same model, paid
  // by the project, a few per address. A key of your own always wins, and a rule needs neither.
  // `jevProxy`: where a visitor's own key goes on the website, where the browser cannot reach the
  // decision model directly - the free-fill service forwards it, uncounted, as the visitor's.
  "decision.fill": async ({ spec, rule = null, concurrency = 8 }, { decisionKey = null, jevProxy = null, fetch: f, trial = trialUrl() } = {}) => {
    const d = parseDecision(spec);
    let legal = 0;
    for (let row = 0; row < 2 ** d.nIn; row++) if (isLegal(d, decodeRow(d, row))) legal += 1;
    if (legal > MAX_FILL_ROWS) throw new ApiError("bad_request", `${legal} legal situations is more than this server fills in one call (${MAX_FILL_ROWS})`);
    const net = f ? { fetch: f } : {};
    let free = null;
    let filler;
    if (rule) filler = ruleFiller(d, rule);
    else if (decisionKey) filler = jevFiller(d, { apiKey: decisionKey, ...(jevProxy ? { url: `${jevProxy}/v1/systemone`, headers: { "x-jev-key": decisionKey } } : {}), ...net });
    else if (trial) {
      try { free = await startTrial(legal, { url: trial, ...net }); }
      catch (error) { throw new ApiError("bad_request", error.message); }
      filler = jevFiller(d, { apiKey: free.token, url: free.jevUrl, ...net });
    } else throw new ApiError("bad_request", "no decision-model key on this machine: write one to ~/.config/gatecraft/jev.token (see https://typesafe.ai)");
    const fill = await fillDecision(d, filler, { concurrency: Math.min(Math.max(1, concurrency), 16) });
    const answered = fill.rows.filter((r) => r.choice);
    return { fill, legal, answered: answered.length, failed: fill.rows.filter((r) => r.source === "failed").length, settled: answered.filter((r) => (r.confidence ?? 1) >= d.threshold).length, ...(free ? { trial: { left: free.left, limit: free.limit } } : {}) };
  },

  // Run locally, the page can put the decision-model key where this server reads it, so nobody
  // needs a terminal. Only the local server offers this (the website has no server and keeps a
  // key in the page instead); the key is written, never returned.
  "key.save": ({ key }, { keyStore = null } = {}) => {
    if (!keyStore) throw new ApiError("bad_request", "saving a key is only possible when gatecraft runs on your own computer");
    try { const r = keyStore.save(key); return { saved: true, file: r.file, overriddenByEnv: r.overriddenByEnv }; }
    catch (error) { throw new ApiError("bad_request", error.message); }
  },
  "key.forget": (_params, { keyStore = null } = {}) => {
    if (!keyStore) throw new ApiError("bad_request", "removing a key is only possible when gatecraft runs on your own computer");
    const r = keyStore.forget();
    return { removed: true, file: r.file, overriddenByEnv: r.overriddenByEnv };
  },

  // How many free fills this address has left. Asked by the page before it offers one.
  "decision.trial": async (_params, { fetch: f, trial = trialUrl() } = {}) => {
    const status = trial ? await trialStatus({ url: trial, ...(f ? { fetch: f } : {}) }).catch(() => null) : null;
    return status ? { available: true, ...status } : { available: false };
  },

  // Compile the filled table into a circuit proven on every row.
  "decision.freeze": ({ spec, fill, overrides = null, anchors = null, steps }) => {
    const d = parseDecision(spec);
    const frozen = freezeDecision(d, fill, { overrides, anchorFile: anchors, steps: steps === undefined ? undefined : Math.min(steps, MAX_STEPS) });
    return {
      certificate: frozen.certificate,
      netlist: netlistJson(d.name, frozen.circuit),
      review: reviewRows(d, frozen.fill),
      rows: frozen.table.counts,
      // Widths, legal codes and the packing convention, so a caller holding the netlist can
      // run the proven circuit itself rather than asking this server what it answers.
      codebook: codebookJson(d),
    };
  },

  // The situations worth putting to a person, drawn across the confidence range. The model's
  // own answers are deliberately not included: a person told them is anchoring on the machine.
  "decision.anchors": ({ spec, fill, count = 20 }) => ({ sheet: drawAnchors(parseDecision(spec), fill, Math.min(Math.max(1, count), 100)) }),

  // Can this decision be delegated at all, and with the threshold where.
  "decision.calibrate": ({ spec, fill, anchors, rule = null }) => calibrateThreshold(parseDecision(spec), fill, anchors, { rule }),

  // One dependency-free module the caller drops into their own program.
  "decision.export": ({ spec, fill, anchors = null, calibration = null, steps }) => {
    const d = atThreshold(parseDecision(spec), calibration);
    const frozen = freezeDecision(d, fill, { anchorFile: anchors, steps: steps === undefined ? undefined : Math.min(steps, MAX_STEPS) });
    return { name: `${d.name}.decision.mjs`, text: decisionModule(frozen, { calibration }) };
  },

  "tapeout.plan": async ({ netlist, rpc, processor, from, chainId, expectImplementation, simulate: wantSimulation = true }) => {
    asObject(netlist, "netlist");
    const rpcUrl = asString(rpc, "rpc");
    if (!/^https?:\/\//i.test(rpcUrl)) throw bad('"rpc" must start with http:// or https://');
    if (chainId !== undefined && (!Number.isInteger(chainId) || chainId < 1)) throw bad('"chainId" must be a positive whole number');
    let plan;
    try {
      const chain = await readChain({ rpcUrl, processor: asString(processor, "processor"), from: asString(from, "from") });
      plan = planTapeout({ name: netlist.name ?? "circuit", netlist, chain, expectChainId: chainId, expectImplementation });
    } catch (error) {
      throw error instanceof ApiError ? error : new ApiError("failed", error.message);
    }
    const out = { plan, signed: false };
    if (wantSimulation !== false) {
      try {
        out.simulation = await simulatePlan({ rpcUrl, plan });
      } catch (error) {
        out.simulationError = error.unsupported ? "this RPC does not support eth_simulateV1" : error.message;
      }
    }
    return out;
  },
};

// Handles one parsed request against a method table (the built-ins, plus whatever plugins
// added). Returns the JSON body and HTTP status; never throws.
export async function handleApi(body, { methods = METHODS, plugins = [], ...rest } = {}) {
  let request;
  try {
    request = asObject(body, "request");
  } catch (error) {
    return { status: 400, body: { ok: false, error: { code: error.code, message: error.message } } };
  }
  const method = typeof request.method === "string" ? request.method : "";
  const handler = methods[method];
  if (!handler) {
    return { status: 404, body: { ok: false, error: { code: "unknown_method", message: `unknown method ${JSON.stringify(method)}; POST {"method":"health.status"} for the list` } } };
  }
  let params;
  try {
    params = request.params === undefined ? {} : asObject(request.params, "params");
  } catch (error) {
    return { status: 400, body: { ok: false, method, error: { code: error.code, message: error.message } } };
  }
  try {
    // The rest of the context is forwarded, not dropped: the server passes the machine own
    // decision-model key through here, and swallowing it made the page report no key while the
    // file sat on disk.
    const result = await handler(params, { methods, plugins, ...rest });
    return { status: 200, body: { ok: true, method, ...(request.id === undefined ? {} : { id: request.id }), result } };
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "failed";
    const status = code === "bad_request" ? 400 : 422;
    return { status, body: { ok: false, method, ...(request.id === undefined ? {} : { id: request.id }), error: { code, message: error.message } } };
  }
}
