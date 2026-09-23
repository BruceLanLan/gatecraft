# gatecraft

English · [中文](README.zh-CN.md)

**Your program makes a small decision over and over, and calls a model for it every time.** It answers differently about a quarter of the time, every call costs money, and you cannot show anyone why it decided what it did.

gatecraft freezes that one decision. It answers every situation your program can be in, once; proves the answers as a NAND circuit on every row, twice; asks **you** twenty questions to check the answers are what you actually want; and hands you a 4 KB file with no dependencies to `import`:

```js
import { decide } from "./refund-call.decision.mjs";
const { action, review } = decide({ age: 0, condition: 1, reason: 0, history: 0, price: 1 });
if (review) handToAPerson(); else actOn(action);
```

| | calling a model each time | frozen with gatecraft |
|---|---|---|
| same input | a different answer **25%** of the time (measured) | always the same answer |
| checked | not at all | every row, by two independent proofs |
| cost per call | tokens | **zero** |
| when it is unsure | answers anyway | **raises its hand** (`review = 1`) and hands it to a person |

**It may also tell you not to use it.** Of six real decisions measured this way, two were ones the model gets confidently wrong — and both passed the row-by-row proof, the independent proof, a repeat and a high confidence. Only the twenty blind questions caught it, which is why that step is a gate, not an option.

## What it looks like

`npm run ui` opens here. Start from a measured example, paste a decision file, or describe the decision in one sentence and let your own model draft it.

![The decision page](docs/images/decision-landing.png)

After the table is filled and proven, poke it. What runs is the netlist that was just proven, drawn gate by gate and lit for the situation you picked:

![Try the frozen decision](docs/images/decision-try.png)

Then twenty situations, **without the model's answers** — shown them, you would be agreeing with the machine instead of judging:

![Twenty blind questions](docs/images/decision-ask.png)

Your answers decide the verdict: **delegate**, **write the rule instead**, or **do not delegate**.

![Threshold and verdict](docs/images/decision-verdict.png)

## Try it in three minutes

Node 20 or later. No install step — there are no dependencies.

```
git clone https://github.com/BruceLanLan/gatecraft && cd gatecraft
npm run ui                        # open http://127.0.0.1:4747
```

Click **Hold a comment**, then **Read it back to me**, then either **Fill and freeze** (one of your three free fills, with the calibrated model) or **fill it from the rule in this file** (free forever). Neither needs a key or an account, and everything after is real: the proof, the circuit you can poke, the twenty questions, the verdict and the download.

## Three ways to fill a decision

Every legal situation has to be answered once. Pick whichever you have:

| | what you need | good for |
|---|---|---|
| **free fills** | nothing — **three per address**, paid by the project | trying the whole flow with the calibrated model before signing up for anything |
| **a rule** | nothing — free and exact | a decision you can already write as an if-statement (the verdict will usually tell you to do just that) |
| **your own model** | the model you set up in the page, or your agent over MCP | everyone without a decision-model account |
| **Jev** (optional) | a free [typesafe.ai](https://typesafe.ai) account; about 1 cent per decision | the best-calibrated confidence |

With your own model, each situation is asked **three times** and the confidence is how often the answers agreed — a chat model's own confidence was measured to carry nothing, while unanimous rows reproduced 96–98% of the time on a repeat. The call count is shown before you start, and the calls go from your browser straight to your provider, on your account.

The free fills are the one exception to "whoever uses a model pays for it": when this machine has no key, a fill goes through a small service at `tapeout.work/gatecraft` that forwards to the same model with the project's key, which never leaves that service. It stores only a count per address, and the address is hashed first. After three, the page points you at the other three ways. Switch it off with `GATECRAFT_TRIAL=off`.

Otherwise gatecraft never calls a model on its own and never pays for one; no key is bundled. To use Jev with your own key, write it where only this machine can read it:

```
mkdir -p ~/.config/gatecraft && printf '%s' 'YOUR_KEY' > ~/.config/gatecraft/jev.token && chmod 600 ~/.config/gatecraft/jev.token
```

## Bring your own agent (MCP)

If you already use Claude Code, Codex or any agent that speaks MCP, you do not need the page. gatecraft runs as an MCP server with seven tools:

```
claude mcp add gatecraft -- node /path/to/gatecraft/scripts/mcp.mjs --out ./gatecraft-out
```

For other clients, the same thing in their config:

```json
{ "mcpServers": { "gatecraft": { "command": "node", "args": ["/path/to/gatecraft/scripts/mcp.mjs", "--out", "./gatecraft-out"] } } }
```

Then ask your agent something like *"freeze the auto-refund decision in our code with gatecraft"*.

| tool | what it does |
|---|---|
| `gatecraft_decision_review` | checks a decision file and reads it back in plain sentences, with what to look at |
| `gatecraft_decision_situations` | lists every legal situation, so the agent can answer them |
| `gatecraft_decision_fill` | fills, freezes and proves (and proves again with Yosys when installed): `rule`, `answers` (the agent's own) or `jev` |
| `gatecraft_decision_anchors` | draws twenty questions **for you** to answer, not the agent |
| `gatecraft_decision_calibrate` | sweeps the threshold against your answers and gives the verdict |
| `gatecraft_decision_decide` | runs the proven circuit on one situation |
| `gatecraft_decision_export` | writes the dependency-free module into your project |

Two things are deliberate. **The twenty anchors must be answered by a person:** the tools say so, calibration records who answered, and anchors an agent answered are labelled a consistency check everywhere, including the exported module's header. **The model's answers never pass through the agent's context:** tools hand each other a directory, not the table, so the agent cannot let an answer slip while it asks you the questions. Nothing is written outside `--out`.

## The command line

The same flow, one step at a time:

```
node scripts/decide.mjs draft     --from "one sentence about the decision" --out out/d
node scripts/decide.mjs fill      --spec out/d/d.decision.json --with rule|chat|jev --out out/d
node scripts/decide.mjs freeze    --spec … --out out/d && node scripts/decide.mjs check --out out/d
node scripts/decide.mjs ask       --spec … --out out/d            # the twenty blind questions
node scripts/decide.mjs calibrate --spec … --out out/d --anchors out/d/anchors.answered.json
node scripts/decide.mjs export    --spec … --out out/d            # the 4 KB module
```

## Read this before installing

- **Observations must already be a few discrete codes** — a gear, a tier, a status, a bucketed reading. Anything that needs reading text, recognising a person, calling the network or looking at a clock is on the other side of a wall this tool does not cross; bucketing raw values into codes is your program's job.
- **A decision's size is set by how much a person can spot-check,** not by the circuit. The cap is 16 bits.
- **Who needs this is unproven.** Of 55 real decisions measured, **15%** fell where it pays off — a short rule fails *and* the model settles most situations — and that is an upper bound.
- The sentence-to-circuit workbench and the gallery are still here for circuits that are genuinely that small. Of 300 things people casually wished for, **3%** were.
- The unsigned tape-out plan has **never been signed**; it has only been verified read-only on chain.

Every number on this page comes from a dated measurement in [docs/findings.md](docs/findings.md).

## Documentation

- [How it works](docs/method.md) — the codebook, the three fills, the proofs, the anchors, calibration and export, and why each is built that way.
- [What was measured](docs/findings.md) — the experiments behind the design, including the ones that went against it.
- [Compiler reference](docs/compiler.md) — expression programs, the four editors, the local API, output files, wide tables, stateful circuits, the tape-out plan.

## Development

```
npm test          # the whole suite, exhaustive over every input space
```

`npm run setup` and `npm run check` are the maintainer's release guard: they enforce a neutral git identity and scan for a private word list that is not in this repository. You do not need them to use or contribute to gatecraft.

## Acknowledgements

**ncd2net** ([@zhuoning293](https://x.com/zhuoning293)) compiles Attention, FFN and Transformer blocks described in pyncd through a fixed-point IR, Verilog and Yosys/ABC into pure NAND circuits — an attention core of 1,024 NAND, checked exhaustively over 2²⁴ inputs with zero errors. gatecraft's second, independent proof (writing the specification as BLIF and having Yosys prove the circuit equal with a miter and SAT, `src/boolean-ir.mjs`) comes from seeing that work: before it there was only one proof, our own. The two do different things — ncd2net lowers *models* into circuits, gatecraft lowers *judgements* — on the same foundation.

## License

[MIT](LICENSE) © BruceLanLan
