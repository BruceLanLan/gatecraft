// Files a compile leaves behind, and reading a netlist back.
//
//   <out>/circuit.netlist.json      the circuit: shape, element list, netlist bytes
//   <out>/circuit.certificate.json  what was proven and how to reproduce it
//   <out>/table.json                the complete table that was compiled
//   <out>/circuit.blif              the same circuit as BLIF, for a fab's own tools
//   <out>/circuit.firsto.json       the flow-import envelope tapeout.firsto.ai reads
//   <out>/app.html                  the circuit as a self-contained page anyone can open
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NETLIST_FORMAT, artifactFiles, netlistJson } from "./job.mjs";
import { OPCODE, circuitFromElements, decodeElements, hexToBytes } from "./netlist.mjs";

export { NETLIST_FORMAT, netlistJson };

export function writeArtifacts(outDir, name, result) {
  mkdirSync(outDir, { recursive: true });
  const texts = artifactFiles(name, result);
  const files = {
    netlist: join(outDir, "circuit.netlist.json"),
    certificate: join(outDir, "circuit.certificate.json"),
    table: join(outDir, "table.json"),
    blif: join(outDir, "circuit.blif"),
    firsto: join(outDir, "circuit.firsto.json"),
    app: join(outDir, "app.html"),
  };
  writeFileSync(files.netlist, texts["circuit.netlist.json"]);
  writeFileSync(files.certificate, texts["circuit.certificate.json"]);
  writeFileSync(files.table, texts["table.json"]);
  writeFileSync(files.blif, texts["circuit.blif"]);
  writeFileSync(files.firsto, texts["circuit.firsto.json"]);
  writeFileSync(files.app, texts["app.html"]);
  return files;
}

// Reads a netlist file and decodes its bytes, so everything downstream works
// from the bytes that would actually be taped out, not from the element list.
export function readNetlist(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (json.format !== NETLIST_FORMAT) throw new Error(`${path} is not a ${NETLIST_FORMAT} file`);
  const elements = decodeElements(hexToBytes(json.netlistHex), json.nIn);
  const circuit = circuitFromElements(elements, json.nIn, json.nOut);
  if (circuit.nNand !== json.nand || circuit.nLatch !== json.latch) throw new Error(`${path}: element counts do not match its netlist bytes`);
  if (elements.some((e) => e.op === OPCODE.REF)) throw new Error(`${path}: REF elements are not supported`);
  return { json, circuit };
}
