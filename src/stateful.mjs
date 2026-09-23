// A stateful circuit as the synthesis form: each latch's q becomes an extra
// input bit and its d an extra output, so (inputs, state) -> (outputs, next
// state) is an ordinary table the annealer and rebuild() understand. Latch i
// stays state bit i.
import { OPCODE } from "./netlist.mjs";
import { MAX_BITS } from "./verify.mjs";

export function unwrap(original) {
  const { nIn, nOut, elements } = original;
  if (elements.some((e) => e.op === OPCODE.REF)) throw new Error("REF elements are not supported");
  const latches = elements.filter((e) => e.op === OPCODE.LATCH);
  const nLatch = latches.length;
  if (!nLatch) throw new Error("the circuit has no latches; compile its truth table with compile-table instead");
  if (nIn + nLatch > MAX_BITS) throw new Error(`${nIn + nLatch} bits of (input, state) is too wide to check exhaustively`);
  const gate0 = 2 + nIn + nLatch;
  const map = new Map();
  for (let s = 0; s < 2 + nIn; s++) map.set(s, s);
  let li = 0;
  let gi = 0;
  for (const e of elements) map.set(e.out, e.op === OPCODE.LATCH ? 2 + nIn + li++ : gate0 + gi++);
  const at = (s) => {
    const v = map.get(s);
    if (v === undefined) throw new Error(`signal ${s} is not defined in the circuit`);
    return v;
  };
  const gates = elements.filter((e) => e.op === OPCODE.NAND).map((e) => [at(e.a), at(e.b)]);
  const outputs = [...original.outputs.map(at), ...latches.map((l) => at(l.d))];
  return { nIn, nLatch, nOut, gates, outputs };
}
