// The circuit as BLIF, the netlist format the fabs' own tools read (Yosys, ABC, SIS - and
// tapeout.net's canvas imports it directly, mints the gates and tapes out with the user's own
// wallet). Handing a BLIF over is the short way to a real chip: gatecraft proves the circuit
// and exports it; whoever burns it owns the wallet, the money and the transaction.
//
// Only two constructs are used, and both are exactly what the compiler emits:
//
//   .names a b out      with the NAND on-set (0- 1 / -0 1): out is 0 only when a and b are 1
//   .latch d q re clk 0  one bit of memory, 0 at power-on, updated on the clock
//
// Signal names are n<signal>, inputs x0.., outputs y0.., latches s0.., so a reader can line
// the file up with the certificate. `names`, when given, renames the pins after the program.
import { OPCODE } from "./netlist.mjs";

export const BLIF_ZERO = "gnd";
export const BLIF_ONE = "vdd";

// Full pin names from a compiled expression program's certificate: no truncation here, a
// netlist file has room. A value of several bits gets one pin per bit.
export function blifNames(expression) {
  const spread = (fields = []) => fields.flatMap((f) => Array.from({ length: f.width }, (_, i) => (f.width === 1 ? f.name : `${f.name}${i}`)));
  return { x: spread(expression?.inputs), s: spread(expression?.state), y: spread(expression?.outputs) };
}

export function toBlif(circuit, { name = "circuit", names = null } = {}) {
  const { nIn, nOut, elements, outputs } = circuit;
  const latches = elements.filter((e) => e.op === OPCODE.LATCH);
  const pin = (kind, index) => {
    const label = `${kind}${index}`;
    const given = names?.[kind]?.[index];
    return given && given !== label ? `${label}_${given}` : label;
  };
  // Every signal's name: constants, inputs, latch outputs, then plain gates.
  const wire = new Map([[0, BLIF_ZERO], [1, BLIF_ONE]]);
  for (let i = 0; i < nIn; i++) wire.set(2 + i, pin("x", i));
  latches.forEach((latch, i) => wire.set(latch.out, pin("s", i)));
  const named = (signal) => wire.get(signal) ?? `n${signal}`;

  const lines = [
    `# ${name}: ${elements.filter((e) => e.op === OPCODE.NAND).length} NAND${latches.length ? ` + ${latches.length} LATCH` : ""}, written by gatecraft`,
    `.model ${name}`,
    `.inputs ${Array.from({ length: nIn }, (_, i) => pin("x", i)).join(" ")}`,
    `.outputs ${Array.from({ length: nOut }, (_, i) => pin("y", i)).join(" ")}`,
  ];
  // Constants are built from a real signal rather than written as zero-input tables: a
  // zero-input `.names` is legal BLIF but some importers accept one- and two-input tables
  // only (tapeout.firsto.ai's does), and NAND(ref, NOT ref) is 1 whatever ref is.
  const usesConstant = (value) => elements.some((e) => (e.op === OPCODE.NAND ? e.a === value || e.b === value : e.d === value)) || outputs.includes(value);
  const needsConstant = usesConstant(0) || usesConstant(1);
  if (needsConstant) {
    const reference = nIn > 0 ? pin("x", 0) : latches.length ? pin("s", 0) : null;
    if (!reference) throw new Error("a circuit with no inputs and no latches has no signal to build a constant from");
    const inverted = `n_not_${reference}`;
    lines.push(`.names ${reference} ${inverted}`, "0 1");
    lines.push(`.names ${reference} ${inverted} ${BLIF_ONE}`, "0- 1", "-0 1");
    if (usesConstant(0)) lines.push(`.names ${BLIF_ONE} ${BLIF_ZERO}`, "0 1");
  }
  for (const element of elements) {
    if (element.op !== OPCODE.NAND) continue;
    lines.push(`.names ${named(element.a)} ${named(element.b)} ${named(element.out)}`, "0- 1", "-0 1");
  }
  latches.forEach((latch) => lines.push(`.latch ${named(latch.d)} ${named(latch.out)} re clk 0`));
  // Output pins are their own names, so a duplicate or a constant output still has a pin.
  outputs.forEach((signal, index) => {
    const target = pin("y", index);
    if (named(signal) === target) return;
    lines.push(`.names ${named(signal)} ${target}`, "1 1");
  });
  lines.push(".end", "");
  return lines.join("\n");
}
