// Small hand-built stateful circuits for tests/stateful.test.mjs.
import { CircuitBuilder } from "../../src/netlist.mjs";

// 1-bit delay: output q, next q = t. The latch reads the input directly and the
// output q must be copied to the tail through two NANDs, so no layout of this
// behaviour has fewer than finalize()'s two.
export function delay() {
  const b = new CircuitBuilder(1);
  const l = b.allocLatch();
  l.setD(b.input(0));
  return b.finalize([l.q], { key: "delay" });
}

// 1-bit toggle: output q, next q = q XOR t. Four NANDs for the XOR plus the two
// output buffers finalize() adds.
export function toggle() {
  const b = new CircuitBuilder(1);
  const l = b.allocLatch();
  const t = b.input(0);
  const n1 = b.nand(l.q, t);
  l.setD(b.nand(b.nand(l.q, n1), b.nand(t, n1)));
  return b.finalize([l.q], { key: "toggle" });
}

// The same toggle written without care: XOR from inverters and an OR, a
// needless double inversion before the latch, and finalize() buffers.
export function wastefulToggle() {
  const b = new CircuitBuilder(1);
  const l = b.allocLatch();
  const t = b.input(0);
  const nq = b.nand(l.q, l.q);
  const nt = b.nand(t, t);
  const x = b.nand(b.nand(l.q, nt), b.nand(nq, t));
  const nx = b.nand(x, x);
  l.setD(b.nand(nx, nx));
  return b.finalize([l.q], { key: "wasteful-toggle" });
}

// 2-bit counter with enable e: next = count + e (mod 4), output = carry out.
export function wastefulCounter() {
  const b = new CircuitBuilder(1);
  const q0 = b.allocLatch();
  const q1 = b.allocLatch();
  const e = b.input(0);
  const not = (s) => b.nand(s, s);
  const and = (x, y) => not(b.nand(x, y));
  const xor = (x, y) => b.nand(b.nand(x, not(y)), b.nand(not(x), y));
  const c0 = and(e, q0.q);
  q0.setD(xor(q0.q, e));
  q1.setD(xor(q1.q, c0));
  return b.finalize([and(c0, q1.q)], { key: "wasteful-counter" });
}
