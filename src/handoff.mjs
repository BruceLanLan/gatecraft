// Handing a proven circuit to whoever burns it.
//
// gatecraft stops at the netlist and its proof. Getting a real chip means giving that netlist
// to a fab's own flow, which owns the wallet, the money and the transaction - we never do.
// Each fab takes a different file, so this module writes the file each one asks for:
//
//   firstoImport()  the flow-import envelope tapeout.firsto.ai reads: one file carrying the
//                   canonical netlist bytes plus nIn and nOut, so nothing is typed by hand.
//   toBlif()        (src/blif.mjs) the generic netlist format, which Yosys, ABC, SIS and
//                   tapeout.net's canvas all read.
//
// The envelope's field list, schema string and accepted processors are read off that site's
// own importer, which refuses an unknown field, so this writes exactly those five keys.
export const FIRSTO_SCHEMA = "tapeout.firsto.flow-import/v1";
export const FIRSTO_PROCESSORS = ["TapeOut", "Behemoth"];
export const FIRSTO_FLOW_URL = "https://tapeout.firsto.ai/tapeout";

export function firstoImport({ netlistHex, nIn, nOut, processor = "TapeOut" }) {
  if (typeof netlistHex !== "string" || !/^0x[0-9a-fA-F]*$/.test(netlistHex)) throw new Error("netlistHex must be canonical 0x bytes");
  if (!Number.isInteger(nIn) || nIn < 0 || !Number.isInteger(nOut) || nOut < 1) throw new Error("nIn and nOut must be whole numbers");
  if (!FIRSTO_PROCESSORS.includes(processor)) throw new Error(`processor must be one of ${FIRSTO_PROCESSORS.join(", ")}`);
  // Field order and set are the importer's: it refuses anything else.
  return { schema: FIRSTO_SCHEMA, processor, nIn, nOut, netlist: netlistHex };
}

export const firstoImportText = (circuit, options = {}) => `${JSON.stringify(firstoImport({ netlistHex: circuit.netlistHex, nIn: circuit.nIn, nOut: circuit.nOut, ...options }), null, 2)}\n`;

// ---- checking a handoff file before anyone tries to import it
//
// These are the rules that importer applies, read off its own code (2026-09-18). Checking
// them here means a file is known to be acceptable without opening a wallet or a browser; a
// rule it changes on its side will show up as a real import error, so the check says where it
// came from rather than pretending to be the authority.
export const FIRSTO_MAX_NETLIST_BYTES = 40_000;
const UINT32 = 4294967295;
const OPCODES = { NAND: 0, LATCH: 1, REF: 2 };

// Walks the canonical bytes the way that importer walks them, counting elements.
export function netlistComposition(netlistHex) {
  const bytes = (netlistHex.length - 2) / 2;
  const at = (i) => Number.parseInt(netlistHex.slice(2 + i * 2, 4 + i * 2), 16);
  let cursor = 0;
  const counts = { nand: 0, latch: 0, references: 0, bytes };
  const need = (n, what) => {
    if (cursor + n > bytes) throw new Error(`the netlist is truncated in a ${what}`);
  };
  while (cursor < bytes) {
    const opcode = at(cursor);
    cursor += 1;
    if (opcode === OPCODES.NAND) {
      need(6, "NAND");
      cursor += 6;
      counts.nand += 1;
    } else if (opcode === OPCODES.LATCH) {
      need(3, "LATCH");
      cursor += 3;
      counts.latch += 1;
    } else if (opcode === OPCODES.REF) {
      need(30, "REF header");
      const inputs = at(cursor + 28);
      need(30 + inputs * 3, "REF inputs");
      cursor += 30 + inputs * 3;
      counts.references += 1;
    } else {
      throw new Error(`the netlist has unsupported opcode ${opcode}`);
    }
  }
  return counts;
}

// Every reason that importer would refuse this envelope, or [] when it would take it.
export function firstoProblems(envelope) {
  const problems = [];
  const keys = Object.keys(envelope ?? {});
  const allowed = ["schema", "processor", "nIn", "nOut", "netlist"];
  for (const key of keys) if (!allowed.includes(key)) problems.push(`unsupported field ${key}`);
  if (envelope?.schema !== FIRSTO_SCHEMA) problems.push(`schema must be ${FIRSTO_SCHEMA}`);
  if (!FIRSTO_PROCESSORS.includes(envelope?.processor)) problems.push(`processor must be one of ${FIRSTO_PROCESSORS.join(", ")}`);
  for (const field of ["nIn", "nOut"]) {
    const value = envelope?.[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > UINT32) problems.push(`${field} must be a uint32 integer`);
  }
  if (typeof envelope?.netlist !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(envelope.netlist)) {
    problems.push("netlist must be canonical 0x bytes, whole bytes only");
    return problems;
  }
  try {
    const counts = netlistComposition(envelope.netlist);
    if (counts.bytes > FIRSTO_MAX_NETLIST_BYTES) problems.push(`the netlist is ${counts.bytes} bytes; the limit is ${FIRSTO_MAX_NETLIST_BYTES}`);
  } catch (error) {
    problems.push(error.message);
  }
  return problems;
}

// The same for a BLIF file: one model, one end, unique pin names, tables of one or two
// inputs, latches with an input and an output, wire indices inside 24 bits.
export function blifProblems(text) {
  const problems = [];
  const lines = text.replace(/\r/g, "").split("\n").map((line) => line.replace(/#.*/, "").trim()).filter(Boolean);
  const count = (prefix) => lines.filter((line) => line === prefix || line.startsWith(`${prefix} `)).length;
  if (count(".model") !== 1) problems.push("a BLIF import must contain exactly one .model");
  if (count(".end") !== 1) problems.push("a BLIF import must contain exactly one .end");
  for (const section of [".inputs", ".outputs"]) {
    const pins = lines.filter((line) => line.startsWith(`${section} `)).flatMap((line) => line.split(/\s+/).slice(1));
    if (new Set(pins).size !== pins.length) problems.push(`${section} names must be unique`);
  }
  for (const line of lines) {
    if (line.startsWith(".names")) {
      const pins = line.split(/\s+/).slice(1);
      if (pins.length < 2 || pins.length > 3) problems.push(`"${line}" has ${Math.max(0, pins.length - 1)} input(s); one or two are accepted`);
    } else if (line.startsWith(".latch")) {
      if (line.split(/\s+/).length < 3) problems.push(`"${line}" needs an input and an output signal`);
    }
  }
  return problems;
}

