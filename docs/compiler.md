# gatecraft compiler reference

[中文](compiler.zh-CN.md) · English

This page covers the compiler underneath the decision flow: expression programs, the four editors, the local API, the files a compile leaves behind, wide tables, optimisation objectives, stateful circuits and the unsigned tape-out plan. The product is introduced in the [README](../README.md); the method and the measurements behind it are in [method](method.md) and [findings](findings.md). The Chinese version of this page is the fuller one, with every benchmark table.

## Command line

Node ≥ 20, zero dependencies, run from the repository root. Every command takes `--help`.

| command | result (default settings) |
|---|---|
| `node scripts/compile-table.mjs --table examples/majority3.table.json --name majority3` | 6 NAND, depth 5, 8/8 rows exact |
| `node scripts/compile-table.mjs --table examples/adder4.table.json --name adder4` | 4-bit adder with carry: 38 NAND, 512/512 rows exact |
| `node scripts/compile-grid.mjs --map examples/grid-demo.map.json --labels stay,left,right,jump --name grid-demo` | 40 NAND, 256/256 rows exact |
| `node scripts/compile-fsm.mjs --spec examples/counter.fsm.json --name counter` | 2-bit counter with enable: 10 NAND + 2 LATCH |
| `node scripts/compile-expr.mjs --spec examples/thermostat.expr.json --name thermostat` | named inputs and outputs, one expression each |
| `node scripts/decide.mjs …` | the decision flow; see below |

A table can also be given as a function: `node scripts/compile-table.mjs --fn "(x&1)^((x>>1)&1)" --nIn 2 --nOut 1 --name xor2`.

## Expression programs

Name the inputs and their widths, and write each output as an expression:

```json
{
  "inputs": { "temp": 7, "target": 7, "heating": 1 },
  "let": { "cold": "temp + 2 < target", "warm": "temp > target + 1" },
  "outputs": {
    "heat": { "width": 1, "expr": "cold || (heating && !warm)" },
    "error": { "width": 7, "expr": "temp > target ? temp - target : target - temp" }
  }
}
```

- Values are **exact integers**; intermediate results never overflow. Each output is taken modulo 2^width, so negatives wrap as two's complement, like hardware.
- Operators and precedence are JavaScript's: `?: || && | ^ & == != < <= > >= << >> >>> + - * / %`, unary `~ ! -`, bit slices `a[3]` and `a[7:4]`.
- Inputs are packed from the least significant bit in declaration order, at most 20 bits in total; the certificate records which bits each name occupies.
- Expressions that cannot become a definite circuit are rejected before compiling, with the position: a divisor that may be below 1, `>>>` on a value that may be negative, unknown names, reversed slices.
- **Memory:** add `state` for anything that remembers (counting, toggling, "three in a row"). Each state value lives in LATCHes, starts at 0, and becomes its `next` on every tick.
- **Examples** (`"examples": [{ "given": …, "expect": … }]`) are checked on the program before anything is compiled; one that fails stops the build.

The compiler takes two routes and keeps the smaller: the whole table through a binary decision diagram, and a structural build from the expression itself (`+` as a ripple-carry adder, `*` as an array multiplier, `<` as a borrow chain, variable shifts as barrel shifters). Both starting circuits are checked on every row before annealing. On an 8-bit adder the structural route gives 68 NAND against 161 from the table alone.

## The page

```
npm run ui        # then open http://127.0.0.1:4747/
```

- **Decision** (the default view): the flow in the [README](../README.md).
- **One sentence → one circuit:** say what a small circuit should do; four sentences on the right and fourteen shapes below need no key. Check it with examples, prove it, then flip inputs and watch the gates — the drawing is the netlist that would be taped out, running gate by gate. Click any gate to see what it is computing right now.
- **Gallery:** every shape as a working app, compiled, proven and running in the page; each can be downloaded as a single HTML file.
- **Workbench:** four editors (expression, decision grid, truth table, state machine), compile settings (steps, seed, objective), and the unsigned tape-out plan.

The server listens on 127.0.0.1 only and serves `ui/`, `src/` and `examples/`. The page connects nowhere else except the model provider you choose (with your own key) and the RPC you type in for a tape-out plan. It never touches a wallet, a private key or a transaction.

## Local API

The same address answers a local JSON API for other programs on this machine: 127.0.0.1 only, Host checked, requests from other pages' origins refused.

```
curl -s localhost:4747/api        # the methods it answers
curl -s localhost:4747/api -d '{"method":"compile.expr","params":{"spec":{"inputs":{"a":1,"b":1,"c":1},"outputs":{"pass":{"width":1,"expr":"a + b + c >= 2"}}},"name":"vote"}}'
```

Replies are `{"ok":true,"method":…,"result":…}` or `{"ok":false,…,"error":{"code":…,"message":…}}`. Methods include `program.check`, `program.run`, `program.table`, `compile.expr|table|grid|fsm`, `circuit.simulate`, `describe.prompt` (the server never calls a model), `describe.read`, `decision.review|fill|freeze|anchors|calibrate|export`, and `tapeout.plan` (unsigned). Plugins dropped into `~/.config/gatecraft/api-plugins/` add methods under their own prefix; `--token` requires a bearer token; `--no-api` serves the page only.

For an agent, prefer the [MCP server](../README.md#bring-your-own-agent-mcp).

## Files a compile leaves behind

In `out/<name>/`:

- `circuit.netlist.json` — pins, gate count, depth, the netlist bytes (`netlistHex`) and the element list.
- `circuit.certificate.json` — the table's SHA-256, gate counts before and after annealing, rows checked and how, and the `seed` and `steps` to reproduce it.
- `table.json` — the full table that was compiled.
- `circuit.blif` — the same circuit as BLIF, for Yosys, ABC, SIS and fab canvases. Pins are named from the program.
- `circuit.firsto.json` — an import file for [tapeout.firsto.ai](https://tapeout.firsto.ai/tapeout), with exactly the five fields its importer accepts.
- `app.html` — the circuit as a self-contained 7–9 KB web app: controls named from the program, a clock for circuits with memory, the proof printed in the header. No network, no dependencies.

A decision additionally leaves `codebook.json`, `fill.json`, `review.json` and the files for the Yosys proof (`spec.blif`, `circuit.blif`, `equiv.ys`).

## Reproducibility

Every random choice in annealing comes from a seeded generator, and the budget is counted in steps, not seconds. Without `--seed` the seed is derived from the table's hash, so the same table compiles to byte-identical netlists and certificates on any machine. The default is 200,000 steps (fewer for very large tables); the steps actually used are in the certificate. A different compiler version may give a different circuit for the same seed.

## Wide tables

The size of a decision diagram depends heavily on variable order. The compiler tries several orders, sifts the smallest, and finally picks by the NAND count actually emitted. Annealing recomputes only the fan-out cone of the gate it changed and abandons a step at the first wrong output; on tables wider than 16 bits it screens a step on a few thousand sampled rows before checking the full table. A 10-bit adder (20 input bits, 1,048,576 rows) compiles and is checked on every row in about a second.

## Optimisation objective

By default annealing minimises NAND count. `--objective cost` minimises `(elements + 6 × LATCH) × depth³` instead, trading a few gates for a shallower circuit; the choice is recorded in the certificate. The seed matters a lot — the same 4-bit adder ranges from 32 to 55 NAND over ten seeds — and more steps help more than more seeds: four times the steps beats the best of four runs.

## Shrinking an existing stateful circuit

`node scripts/anneal-stateful.mjs <module> <export> --name NAME` takes an existing NAND + LATCH circuit, turns each LATCH into an extra input and output, anneals the full (input, state) table, wraps it back, and checks every combination. It refuses (exit code 2) when the result is not smaller.

## Unsigned tape-out plan

```
node scripts/tapeout-manifest.mjs --netlist out/counter/circuit.netlist.json \
     --rpc <RPC> --processor <processor contract> --from <your wallet address> \
     [--chain-id 56] [--expect-implementation <address>] [--skip-simulation] [--out plan.json]
```

It reads fees, token prices, supply caps, your balances and the next circuit id from one block, writes the unsigned transactions in the order they must be signed, and simulates them on that block with `eth_simulateV1`, refusing to write a plan unless every transaction succeeds and the circuit the processor records matches the netlist. All addresses are arguments; the tool holds no private key and broadcasts nothing. **No plan made by it has ever been signed** — it has only been verified read-only on BSC mainnet (2026-09-15).

## Tests

`npm test` covers, exhaustively over the whole input space: randomised rebuild fuzzing, round trips through every compiler, stateful shrinking and its refusals, the tape-out plan against a local fake chain, the page (modules it loads use no Node built-ins, its compile output is byte-identical to the command line's, the server serves nothing else), the decision flow end to end, and the MCP server over stdio.
