// The specification as Boolean logic a third-party tool can read, next to the circuit.
//
// Everything this compiler proves, it proves with its own evaluator. A person who does not
// want to trust that evaluator can now hand two files to Yosys - the table the circuit was
// compiled from, and the circuit - and have an unrelated program prove they are the same
// function on every input. The table is written as BLIF logic (.names with its on-set), the
// circuit as the BLIF the exporter already writes, and a short script builds a miter of the
// two and asks a SAT solver to find any input where they differ. "UNSAT" is the proof.
//
// It is a second, independent proof of the same claim, not a bigger one: the table still has
// to be enumerable, so this does not lift the 20-bit ceiling. Raising that would mean letting
// ABC synthesise from the table and importing its netlist, which is a different piece of work.
import { BLIF_ONE, BLIF_ZERO, toBlif } from "./blif.mjs";

// Writing a table as one on-set line per row is fine up to here and silly beyond.
export const MAX_SPEC_BITS = 16;

const pinNamer = (names) => (kind, index) => {
  const label = `${kind}${index}`;
  const given = names?.[kind]?.[index];
  return given && given !== label ? `${label}_${given}` : label;
};

// A combinational table as BLIF: inputs x0.., outputs y0.., one .names per output bit listing
// every input row on which that bit is 1. Pin names follow toBlif so the two files line up.
export function specBlif(table, { name = "spec", names = null } = {}) {
  const { nIn, nOut, ys } = table;
  if (table.nState) throw new Error("a table with state has no combinational specification; only the blocks of a decision or a combinational program can be handed to a third-party prover");
  if (nIn > MAX_SPEC_BITS) throw new Error(`${nIn} input bits is more than the ${MAX_SPEC_BITS} a specification table is written out for`);
  if (ys.length !== 2 ** nIn) throw new Error(`the table has ${ys.length} rows, ${2 ** nIn} expected`);
  const pin = pinNamer(names);
  const inputs = Array.from({ length: nIn }, (_, i) => pin("x", i));
  const outputs = Array.from({ length: nOut }, (_, k) => pin("y", k));
  const lines = [`# ${name}: the table itself, ${ys.length} rows, written by gatecraft`, `.model ${name}`, `.inputs ${inputs.join(" ")}`, `.outputs ${outputs.join(" ")}`];
  for (let k = 0; k < nOut; k++) {
    lines.push(`.names ${inputs.join(" ")} ${outputs[k]}`);
    for (let row = 0; row < ys.length; row++) {
      if (!((ys[row] >>> k) & 1)) continue;
      let bits = "";
      for (let i = 0; i < nIn; i++) bits += (row >>> i) & 1 ? "1" : "0";
      lines.push(`${bits} 1`);
    }
  }
  lines.push(".end", "");
  return lines.join("\n");
}

// The Yosys script: read both, build a miter whose single output is 1 on any input where
// they differ, and prove with SAT that it can never be 1. The circuit's constants (gnd/vdd)
// are ordinary logic in its BLIF, so nothing special is needed for them.
export function equivalenceScript({ specFile = "spec.blif", circuitFile = "circuit.blif", specModel = "spec", circuitModel = "circuit" } = {}) {
  return [
    `# Proves ${circuitFile} computes exactly ${specFile}, with Yosys and its SAT solver.`,
    `#   yosys -q -s equiv.ys      (exit code 0 = proven; anything else = a differing input was found or a file did not read)`,
    `read_blif ${specFile}`,
    `read_blif ${circuitFile}`,
    `miter -equiv -flatten -make_assert ${specModel} ${circuitModel} miter`,
    `hierarchy -top miter`,
    `sat -verify -prove-asserts -set-init-zero miter`,
    "",
  ].join("\n");
}

// The three files together, for a compiled combinational table.
export function booleanIrFiles(name, { circuit, table }, { names = null } = {}) {
  const circuitModel = name;
  const specModel = `${name}_spec`;
  return {
    "spec.blif": specBlif(table, { name: specModel, names }),
    "circuit.blif": toBlif(circuit, { name: circuitModel, names }),
    "equiv.ys": equivalenceScript({ specModel, circuitModel }),
  };
}

export { BLIF_ONE, BLIF_ZERO };
