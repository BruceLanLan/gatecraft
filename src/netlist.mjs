export const OPCODE = Object.freeze({ NAND: 0, LATCH: 1, REF: 2 });

function assertSignal(signal, nextSignal) {
  if (!Number.isInteger(signal) || signal < 0 || signal >= nextSignal) {
    throw new RangeError(`Invalid or forward signal reference: ${signal}`);
  }
}

function pushU24(bytes, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new RangeError(`u24 out of range: ${value}`);
  }
  bytes.push((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function pushU64(bytes, value) {
  const bigint = BigInt(value);
  if (bigint < 0n || bigint > 0xffffffffffffffffn) {
    throw new RangeError(`u64 out of range: ${value}`);
  }
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    bytes.push(Number((bigint >> shift) & 0xffn));
  }
}

function pushAddress(bytes, address) {
  const hex = String(address).replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`Invalid address: ${address}`);
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
}

export function bytesToHex(bytes) {
  return `0x${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToBytes(hex) {
  const normalized = String(hex).replace(/^0x/, "");
  if (normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    throw new Error("Invalid hex bytes");
  }
  return Uint8Array.from(
    Array.from({ length: normalized.length / 2 }, (_, index) =>
      Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16),
    ),
  );
}

export function packBits(bits) {
  if (!Array.isArray(bits) && !(bits instanceof Uint8Array)) {
    throw new TypeError("Bits must be an array or Uint8Array");
  }
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    if (bit !== 0 && bit !== 1) throw new RangeError(`Invalid bit at index ${index}: ${bit}`);
    bytes[index >>> 3] |= bit << (index & 7);
  });
  return bytes;
}

export function unpackBits(bytes, width = bytes.length * 8) {
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError("Bytes must be an array or Uint8Array");
  }
  if (!Number.isInteger(width) || width < 0 || width > bytes.length * 8) {
    throw new RangeError(`Bit width ${width} exceeds ${bytes.length} input bytes`);
  }
  return Array.from({ length: width }, (_, index) =>
    (bytes[index >>> 3] >>> (index & 7)) & 1,
  );
}

export function encodeElements(elements) {
  const bytes = [];
  for (const element of elements) {
    if (element.op === OPCODE.NAND) {
      bytes.push(OPCODE.NAND);
      pushU24(bytes, element.a);
      pushU24(bytes, element.b);
    } else if (element.op === OPCODE.LATCH) {
      bytes.push(OPCODE.LATCH);
      pushU24(bytes, element.d);
    } else if (element.op === OPCODE.REF) {
      if (element.inputs.length > 255 || element.nOut > 255) {
        throw new RangeError("REF input/output count exceeds one byte");
      }
      bytes.push(OPCODE.REF);
      pushAddress(bytes, element.cpu);
      pushU64(bytes, element.circuitId);
      bytes.push(element.inputs.length, element.nOut);
      for (const signal of element.inputs) pushU24(bytes, signal);
    } else {
      throw new Error(`Unknown opcode: ${element.op}`);
    }
  }
  return Uint8Array.from(bytes);
}

// Exact inverse of encodeElements(): turns a raw netlist byte string back
// into the element list the rest of this module operates on. The wire
// format carries no signal numbers for *outputs* -- the protocol assigns
// them implicitly, in declaration order, starting at 2 + nIn (signal 0 is
// the constant ZERO, signal 1 the constant ONE) -- so nIn must be supplied
// by the caller. For a netlist recovered from a `tapeout(bytes nl,uint32
// nIn,uint32 nOut)` calldata, both numbers sit right there in the same
// calldata.
//
// Rejects a truncated stream or an unknown opcode rather than guessing, since
// the bytes may come from anywhere.
export function decodeElements(bytes, nIn) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (!Number.isInteger(nIn) || nIn < 0) throw new RangeError(`Invalid input count: ${nIn}`);
  let cursor = 0;
  const need = (count, what) => {
    if (cursor + count > data.length) {
      throw new Error(`Truncated netlist: ${what} needs ${count} bytes at offset ${cursor}`);
    }
  };
  const readU24 = () => {
    need(3, "u24");
    const value = (data[cursor] << 16) | (data[cursor + 1] << 8) | data[cursor + 2];
    cursor += 3;
    return value >>> 0;
  };
  const readU64 = () => {
    need(8, "u64");
    let value = 0n;
    for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(data[cursor + index]);
    cursor += 8;
    return value;
  };
  const readAddress = () => {
    need(20, "address");
    let hex = "0x";
    for (let index = 0; index < 20; index += 1) {
      hex += data[cursor + index].toString(16).padStart(2, "0");
    }
    cursor += 20;
    return hex;
  };

  const elements = [];
  let nextSignal = 2 + nIn;
  while (cursor < data.length) {
    const op = data[cursor];
    cursor += 1;
    if (op === OPCODE.NAND) {
      const a = readU24();
      const b = readU24();
      elements.push({ op: OPCODE.NAND, a, b, out: nextSignal++ });
    } else if (op === OPCODE.LATCH) {
      const d = readU24();
      elements.push({ op: OPCODE.LATCH, d, out: nextSignal++ });
    } else if (op === OPCODE.REF) {
      const cpu = readAddress();
      const circuitId = readU64();
      need(2, "REF input/output counts");
      const nRefIn = data[cursor];
      const nOut = data[cursor + 1];
      cursor += 2;
      const inputs = Array.from({ length: nRefIn }, () => readU24());
      const outputs = Array.from({ length: nOut }, () => nextSignal++);
      elements.push({ op: OPCODE.REF, cpu, circuitId, inputs, nOut, outputs });
    } else {
      throw new Error(`Unknown opcode ${op} at offset ${cursor - 1}`);
    }
  }
  return elements;
}

// Convenience wrapper: raw netlist bytes plus the nIn/nOut that accompany
// them in a tapeout() call, in, a simulate()-ready circuit out.
export function decodeCircuit(bytes, nIn, nOut) {
  return circuitFromElements(decodeElements(bytes, nIn), nIn, nOut);
}

export class CircuitBuilder {
  constructor(nIn) {
    if (!Number.isInteger(nIn) || nIn < 0 || nIn > 0xffffff - 2) {
      throw new RangeError(`Invalid input count: ${nIn}`);
    }
    this.nIn = nIn;
    this.elements = [];
    this.nextSignal = 2 + nIn;
  }

  get ZERO() {
    return 0;
  }

  get ONE() {
    return 1;
  }

  input(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.nIn) {
      throw new RangeError(`Input ${index} is outside 0..${this.nIn - 1}`);
    }
    return 2 + index;
  }

  nand(a, b) {
    assertSignal(a, this.nextSignal);
    assertSignal(b, this.nextSignal);
    const out = this.nextSignal++;
    this.elements.push({ op: OPCODE.NAND, a, b, out });
    return out;
  }

  // A LATCH's `d` may legally reference a signal allocated *after* the latch
  // itself in the byte stream; this is how feedback loops close. The reference
  // is therefore not checked here; finalize() validates it against the final
  // signal count.
  latch(d) {
    if (!Number.isInteger(d) || d < 0 || d > 0xffffff) {
      throw new RangeError(`Invalid LATCH d reference: ${d}`);
    }
    const out = this.nextSignal++;
    this.elements.push({ op: OPCODE.LATCH, d, out });
    return out;
  }

  // Allocates a LATCH whose `d` is assigned later, once the logic feeding it
  // (which must be declared *after* the latch) has been built. setD must be
  // called before finalize(). Needed for any feedback loop.
  allocLatch() {
    const out = this.nextSignal++;
    const element = { op: OPCODE.LATCH, d: 0, out };
    this.elements.push(element);
    return {
      q: out,
      setD(signal) {
        if (!Number.isInteger(signal) || signal < 0 || signal > 0xffffff) {
          throw new RangeError(`Invalid LATCH d reference: ${signal}`);
        }
        element.d = signal;
      },
    };
  }

  ref(cpu, circuitId, inputs, nOut) {
    if (!Array.isArray(inputs) || inputs.length > 255) {
      throw new RangeError("REF input count must fit in one byte");
    }
    if (!Number.isInteger(nOut) || nOut < 1 || nOut > 255) {
      throw new RangeError("REF output count must be between 1 and 255");
    }
    for (const signal of inputs) assertSignal(signal, this.nextSignal);
    const outputs = Array.from({ length: nOut }, () => this.nextSignal++);
    this.elements.push({
      op: OPCODE.REF,
      cpu,
      circuitId: BigInt(circuitId),
      inputs: [...inputs],
      nOut,
      outputs,
    });
    return outputs;
  }

  finalize(outputs, metadata = {}) {
    if (!Array.isArray(outputs) || outputs.length === 0) {
      throw new Error("A TapeOut circuit must expose at least one output");
    }
    for (const signal of outputs) assertSignal(signal, this.nextSignal);

    // TapeOut treats the last nOut signals as circuit outputs. Two NAND stages
    // preserve each value while ensuring every public output is at the tail.
    const inverted = outputs.map((signal) => this.nand(signal, signal));
    const bufferedOutputs = inverted.map((signal) => this.nand(signal, signal));

    // Run after the output buffers are allocated, so the final signal space
    // is complete: a LATCH `d` may point anywhere inside it (including
    // forward references — legal on-chain), but never beyond it.
    for (const element of this.elements) {
      if (element.op === OPCODE.LATCH && element.d >= this.nextSignal) {
        throw new RangeError(
          `LATCH d=${element.d} references a signal beyond the final signal space (${this.nextSignal})`,
        );
      }
    }

    const netlist = encodeElements(this.elements);
    const nNand = this.elements.filter((element) => element.op === OPCODE.NAND).length;
    const nLatch = this.elements.filter((element) => element.op === OPCODE.LATCH).length;

    return Object.freeze({
      ...metadata,
      nIn: this.nIn,
      nOut: bufferedOutputs.length,
      outputs: bufferedOutputs,
      elements: this.elements.map((element) => ({ ...element })),
      netlist,
      netlistHex: bytesToHex(netlist),
      netlistBytes: netlist.length,
      gateCount: this.elements.length,
      nNand,
      nLatch,
      signalCount: this.nextSignal,
    });
  }
}

function refKey(cpu, circuitId) {
  return `${String(cpu).toLowerCase()}:${BigInt(circuitId).toString()}`;
}

// One step of a sequential circuit, including LATCH d references to signals
// declared after the latch:
//   pass 0: seed constants, inputs, and every LATCH output from `state`;
//   pass 1: evaluate NAND and REF elements in declaration order;
//   pass 2: resolve each LATCH's next state from its `d` signal.
// REFs are resolved through a resolver supplied either positionally --
// simulate(circuit, inputs, state, (cpu, id) => circuit) -- or as
// options.resolveRef, with cycle detection. gatecraft itself never emits REF.
//
// Stateful REF targets are modelled under an unverified assumption: every REF
// to the same (processor, circuitId) reads and advances one shared state slot.
// options.refState (a Map keyed by `${cpu.toLowerCase()}:${circuitId}`, values
// the target's state bits) holds those slots, and the post-step map is
// returned as `refState`. Check this against the chain before relying on it.
export function simulate(circuit, inputs, state = new Uint8Array(), resolverOrOptions = null) {
  if (inputs.length !== circuit.nIn) {
    throw new Error(`Expected ${circuit.nIn} inputs, received ${inputs.length}`);
  }
  const options =
    typeof resolverOrOptions === "function"
      ? { resolveRef: resolverOrOptions }
      : (resolverOrOptions || {});

  // refState is a single working Map shared by this call and every nested
  // REF call beneath it (recursive calls receive the same Map reference,
  // threaded through `options`), so a stateful target touched at any depth
  // updates one shared entry rather than diverging copies. Cloned once at
  // the outermost call so the caller's own map/object is never mutated.
  const isOutermostCall = !options.refStack;
  const refState = isOutermostCall
    ? new Map(
        options.refState instanceof Map
          ? options.refState
          : Object.entries(options.refState || {}),
      )
    : options.refState;

  const signalCount =
    circuit.signalCount ||
    2 +
      circuit.nIn +
      circuit.elements.reduce(
        (count, element) => count + (element.op === OPCODE.REF ? element.nOut : 1),
        0,
      );
  const signals = new Uint8Array(signalCount);
  signals[0] = 0;
  signals[1] = 1;
  inputs.forEach((value, index) => {
    signals[2 + index] = value ? 1 : 0;
  });

  // Pass 0: seed every LATCH output with its current state bit. LATCH `d`
  // fields may reference signals allocated *after* the latch (forward
  // references are legal on-chain), so their next-state values cannot be
  // resolved until every other signal has settled.
  let latchIndex = 0;
  const latches = [];
  for (const element of circuit.elements) {
    if (element.op === OPCODE.LATCH) {
      signals[element.out] = state[latchIndex] ? 1 : 0;
      latches.push({ d: element.d, index: latchIndex });
      latchIndex += 1;
    }
  }

  // All stateful-REF reads within this call see the same pre-step
  // snapshot (mirrors pass 0/pass 2 for the circuit's own LATCHes: reads
  // never observe a write made earlier in the same step). Writes are
  // collected here and committed to the shared `refState` map only after
  // this whole pass finishes, in declaration order -- so if two REF
  // elements happen to target the same stateful ID with different inputs
  // (an even more speculative case than the base shared-slot assumption;
  // avoid relying on it in a real design), the later declaration wins,
  // deterministically.
  const refReadSnapshot = new Map(refState);
  const pendingRefStateWrites = [];

  // Pass 1: NAND and REF in declaration order. NAND operands may only
  // reference earlier signals (enforced by the builder and by the chain's
  // own decoder), so one linear pass is complete.
  for (const element of circuit.elements) {
    if (element.op === OPCODE.NAND) {
      signals[element.out] = signals[element.a] & signals[element.b] ? 0 : 1;
    } else if (element.op === OPCODE.REF) {
      if (typeof options.resolveRef !== "function") {
        throw new Error(
          "Local REF simulation requires options.resolveRef(cpu, circuitId), or a resolver function passed positionally: simulate(circuit, inputs, state, (cpu, id) => circuit)",
        );
      }
      const key = refKey(element.cpu, element.circuitId);
      const stack = options.refStack || [];
      if (stack.includes(key)) {
        throw new Error(`Recursive REF cycle detected at ${key}`);
      }
      const referenced = options.resolveRef(element.cpu, element.circuitId);
      if (!referenced) {
        throw new Error(`Unresolved REF ${key}`);
      }
      if (referenced.nIn !== element.inputs.length) {
        throw new Error(
          `REF ${key} expects ${referenced.nIn} inputs, encoded ${element.inputs.length}`,
        );
      }
      if (referenced.nOut !== element.nOut) {
        throw new Error(
          `REF ${key} exposes ${referenced.nOut} outputs, encoded ${element.nOut}`,
        );
      }
      const refInputs = element.inputs.map((signal) => (signals[signal] ? 1 : 0));
      let priorRefState = refReadSnapshot.get(key);
      if (priorRefState === undefined) {
        priorRefState = new Uint8Array(referenced.nLatch);
      } else if (priorRefState.length !== referenced.nLatch) {
        throw new Error(
          `refState for ${key} has ${priorRefState.length} bits, referenced circuit declares nLatch=${referenced.nLatch}`,
        );
      }
      const refResult = simulate(referenced, refInputs, priorRefState, {
        ...options,
        refStack: [...stack, key],
        refState,
      });
      if (referenced.nLatch > 0) {
        pendingRefStateWrites.push({ key, newState: refResult.newState });
      }
      element.outputs.forEach((signal, index) => {
        signals[signal] = refResult.outputs[index];
      });
    } else if (element.op === OPCODE.LATCH) {
      // LATCH outputs are seeded in pass 0 and their next state is
      // resolved in pass 2; nothing to do in this pass.
    } else {
      throw new Error(`Unsupported element opcode: ${element.op}`);
    }
  }

  // Commit this level's stateful-REF writes now that pass 1 is complete --
  // never mid-loop, so every read above saw the pre-step snapshot.
  for (const { key, newState: refNewState } of pendingRefStateWrites) {
    refState.set(key, refNewState);
  }

  // Pass 2: resolve each LATCH's next state once every signal has a value.
  const newState = new Uint8Array(latches.length);
  for (const latch of latches) {
    newState[latch.index] = signals[latch.d] ? 1 : 0;
  }

  return {
    outputs: Uint8Array.from(circuit.outputs.map((signal) => signals[signal])),
    newState,
    signals,
    refState,
  };
}

// Wraps a decoded element list (e.g. parsed out of a mined tapeout
// transaction) into the same shape CircuitBuilder#finalize produces, so
// canonical on-chain netlists can be simulated and diff-tested locally.
// Outputs are the last nOut allocated signals, per the protocol.
export function circuitFromElements(elements, nIn, nOut) {
  const totalSignals =
    2 +
    nIn +
    elements.reduce(
      (count, element) => count + (element.op === OPCODE.REF ? element.nOut : 1),
      0,
    );
  const outputs = Array.from({ length: nOut }, (_, index) => totalSignals - nOut + index);
  return Object.freeze({
    nIn,
    nOut,
    outputs,
    elements: elements.map((element) => ({ ...element })),
    nNand: elements.filter((element) => element.op === OPCODE.NAND).length,
    nLatch: elements.filter((element) => element.op === OPCODE.LATCH).length,
    gateCount: elements.length,
  });
}

// Gate-level critical-path depth, per the official TapeOut PoD formula's
// own definition (tapeout.net/#formula, verified 2026-08-20): "d = 最长
// 组合路径，终点可以是输出引脚，也可以是寄存器输入" (longest combinational
// path; the endpoint may be an output pin or a register/LATCH input).
// This is the standard register-to-register critical-path convention:
// primary inputs and LATCH outputs (Q, available at the start of a step)
// are depth 0; each NAND stage adds 1; a REF call is approximated as a
// single stage (its own internal depth is not resolved here -- this
// function is only exact for flat, REF-free netlists; a REF-composed
// circuit gets a lower bound, not an exact figure).
export function criticalPathDepth(circuit) {
  const depth = new Map();
  for (let i = 0; i < 2 + circuit.nIn; i++) depth.set(i, 0);
  // Seed every LATCH output to depth 0 first (available at cycle start,
  // per the register-to-register convention) -- this must happen before
  // the NAND/REF pass below, since LATCH.d is legally allowed to forward-
  // reference a signal declared later in the element list (unlike NAND/REF
  // inputs, which can only reference already-allocated signals), so a
  // later NAND could otherwise read an unseeded LATCH output as depth 0
  // by accident rather than by design if this order were reversed.
  for (const el of circuit.elements) {
    if (el.op === OPCODE.LATCH) depth.set(el.out, 0);
  }
  for (const el of circuit.elements) {
    if (el.op === OPCODE.NAND) {
      const da = depth.get(el.a) ?? 0;
      const db = depth.get(el.b) ?? 0;
      depth.set(el.out, Math.max(da, db) + 1);
    } else if (el.op === OPCODE.REF) {
      const ins = el.inputs.map((s) => depth.get(s) ?? 0);
      const d = Math.max(0, ...ins) + 1;
      for (const o of el.outputs) depth.set(o, d);
    }
  }
  // LATCH.d depths are read in a separate final pass, after every NAND/REF
  // signal has a depth -- d may forward-reference a signal declared later
  // in circuit.elements than the LATCH itself.
  const latchInputDepths = [];
  for (const el of circuit.elements) {
    if (el.op === OPCODE.LATCH) latchInputDepths.push(depth.get(el.d) ?? 0);
  }
  const outputDepths = (circuit.outputs ?? []).map((s) => depth.get(s) ?? 0);
  return Math.max(0, ...outputDepths, ...latchInputDepths);
}

// Official PoD cost formula (tapeout.net/#formula, 2026-08-20): area
// A = g + lambda*s (g = total recursive element count, s = recursive
// LATCH count, lambda = 6), cost C = A * max(d, 1)^beta (beta = 3). For
// a flat (REF-free) circuit, g = nNand + nLatch and
// s = nLatch exactly -- no recursive expansion needed.
export function podCost(circuit, { lambda = 6, beta = 3 } = {}) {
  const nNand = circuit.elements.filter((e) => e.op === OPCODE.NAND).length;
  const nLatch = circuit.elements.filter((e) => e.op === OPCODE.LATCH).length;
  const depth = criticalPathDepth(circuit);
  const area = nNand + nLatch + lambda * nLatch;
  const cost = area * Math.max(depth, 1) ** beta;
  return { nNand, nLatch, depth, area, cost };
}

export function bitsFromUnsigned(value, width) {
  const bigint = BigInt(value);
  if (bigint < 0n || bigint >= 1n << BigInt(width)) {
    throw new RangeError(`${value} does not fit in ${width} unsigned bits`);
  }
  return Array.from({ length: width }, (_, index) =>
    Number((bigint >> BigInt(index)) & 1n),
  );
}

export function unsignedFromBits(bits) {
  return bits.reduce(
    (value, bit, index) => value | (BigInt(bit ? 1 : 0) << BigInt(index)),
    0n,
  );
}
