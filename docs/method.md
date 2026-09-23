# How it works

[中文](method.zh-CN.md) · English

This page describes the method: what each step does, what it guarantees, and why it is built the way it is. The measurements behind each choice are in [findings](findings.md).

## The idea in one paragraph

A program that calls a model to make the same small decision over and over gets a different answer about a quarter of the time, pays for every call, and cannot explain itself. gatecraft asks the question once for **every situation the program can be in**, writes the answers into a table, compiles the table into a NAND circuit, and proves the circuit equals the table on every row — twice, by two independent methods. Then it asks a **person** to answer twenty of those situations without seeing the model's answers, and uses those answers to decide whether the decision should be handed over at all.

## The wall: observations must already be codes

gatecraft does not read text, recognise people, look at a clock or call the network. The program that uses the decision does that, and hands gatecraft a few small codes: a gear, a tier, a status, a bucketed reading. Turning a raw value into a code is the caller's job and is not proven.

This is the hardest boundary of the tool, and it is deliberate: it is exactly where casual wishes fail (text, lists, time, identity, network — [findings §4](findings.md#4-almost-nothing-people-casually-wish-for-fits-in-a-circuit)).

## Step 1 — the codebook

A decision file names each observed field, its width in bits, and **a plain-language phrase for every legal code**:

```json
{
  "name": "comment-hold",
  "question": "What should be done with this comment?",
  "observe": {
    "tone": { "width": 2, "raw": "how the comment is written", "values": { "0": "calmly stated", "1": "sarcastic or mocking", "2": "openly abusive" } },
    "provoked": { "width": 1, "raw": "1 when it replies to a comment that attacked this author", "values": { "0": "unprompted", "1": "a reply to an attack" } }
  },
  "act": { "choices": { "keep": "leave it", "fold": "fold it behind a click", "remove": "take it down" }, "safe": "keep" }
}
```

- **A code with no phrase is illegal.** The circuit answers it with the `safe` action and `review = 1`, by construction of the table — no model's judgement is involved.
- **`safe` is the action that does least damage if taken by mistake**, not the most likely one. Models drafting a codebook tend to pick the least surprising option instead; the read-back always raises it.
- The codebook is hashed. Everything downstream (fills, overrides, anchors, the exported module) carries that hash and refuses a mismatched codebook.

A codebook can be drafted from one sentence by your own model. The draft is then **read back in plain sentences**, with notes on what to check: buckets that look like they need free text, identity, the clock or the network; buckets that do not say where their value comes from; and the `safe` action. Bit widths too small for their own codes are widened and reported — that is arithmetic, not judgement.

## Step 2 — fill

Every legal situation is answered once. Three ways, any of which completes the rest of the flow:

| source | what it is | confidence |
|---|---|---|
| rule | an expression over the fields | exact; every row certain |
| your own model | the model you configured in the page, your agent over MCP, or a chat model on the command line | **agreement rate** over three asks |
| Jev (optional) | a typed decision model that returns calibrated probabilities | the model's probability |

A chat model's self-reported confidence was measured to carry no information, while how often it agrees with itself does ([findings §2](findings.md#2-a-chat-models-own-confidence-carries-nothing-how-often-it-agrees-with-itself-does)). With three asks and the default threshold of 0.7, only a unanimous row is acted on.

Nobody's key is bundled. Your own model runs on your own account; the page talks to your provider directly from the browser, and the local server never sees that key.

## Step 3 — freeze and prove

The filled table becomes the circuit's specification. Each row's output is the action code plus one **review bit**, which is 1 when the situation is illegal, was not answered, or was answered below the confidence threshold.

The table is compiled to NAND gates (binary decision diagram, then simulated annealing to shrink it), and then proven twice:

1. **Row by row, here.** Every one of the 2ⁿ inputs is simulated on the gates and compared with the table.
2. **Independently, by Yosys.** The table and the circuit are both written as BLIF, and Yosys proves them equal with a miter and a SAT solver. A deliberately broken gate makes this proof fail — it is tested.

The certificate records the codebook hash, the fill hash, the gate count, and the rows checked. It also records what it does **not** guarantee: the proof relates the circuit to the table; it says nothing about whether the table is the policy anyone wanted.

## Step 4 — twenty blind questions (anchors)

Twenty situations are drawn, stratified across the fill's confidence, and put to a **person** in the codebook's own words. The model's answers are never shown — a person told what the machine said is agreeing with it rather than judging. The person may pick several answers when several are defensible, or skip a case they would genuinely argue about; a skip is never counted as agreement.

This is the only step that catches a decision the model gets confidently wrong, and it cannot be automated: two models agree with each other about as often as one agrees with itself, so a model answering the anchors turns the correctness check into another consistency check. Over MCP the calibration requires `answered_by`, and anchors an agent answered are labelled as such everywhere, including the exported module's header.

## Step 5 — calibrate

The confidence threshold is swept from 0.9 down to 0.3. At each rung: how much the table would decide, how many of the person's answers fall on rows it would act on, and how many of those agree. The lowest rung where at least five answers fall and **all** of them agree is the calibrated threshold. The verdict is one of:

| verdict | meaning |
|---|---|
| delegate | hand it over at this threshold; it decides this share and hands the rest to a person |
| write the rule instead | safe, but a stated rule already matches more than 85% of what it would decide — ship the if-statement |
| do not delegate | either it contradicts the person where it would act (answering more will not help), or too few answers fall where it acts yet (answer more and calibrate again) |

A table filled from a rule carries one certainty on every row, so the sweep collapses to a single rung and says so.

## Step 6 — export

The result is one ES module, about 4 KB, with no dependencies, no network and no server:

```js
import { decide } from "./comment-hold.decision.mjs";
const { action, review } = decide({ tone: 2, target: 1, provoked: 0, history: 0, stakes: 0 });
if (review) handToAPerson(); else actOn(action);
```

It embeds the **table**, not the netlist: the proof is that the circuit equals the table on every row, so shipping the table ships the proven behaviour, and a lookup is faster than simulating gates. The table is frozen at the **calibrated** threshold, and export refuses a table frozen at any other. Export refuses a decision calibrated "do not delegate". The module's header says whether its table was checked against a person.

## The attention boundary

Decisions are capped at 16 bits. Not because proof gets hard — filling 65,536 situations costs about a dollar — but because twenty blind answers spread over that many situations stop meaning anything ([findings §7](findings.md#7-a-decisions-size-is-limited-by-a-persons-attention-not-by-the-circuit)). Make decisions small enough that twenty answers are a real sample.

## Pre-registration

Every experiment behind this tool wrote down, before any data came in, what result would support it, what would refute it, and what would count as "no product". When a result arrived after the fact, or a criterion turned out to be badly written, that is reported alongside the number — the pre-registered verdict is reported even when a nicer one is available. The evaluation tools used are in `tools/` (for example `tools/band-score.mjs`, `tools/calibrate.mjs`, `tools/score-rules.mjs`), and the anchors used for the shipped examples are in `examples/*.anchors.json`, each with a note on how they were made.
