# What was measured

[中文](findings.zh-CN.md) · English

gatecraft was built by measuring before deciding, and several of its design choices exist because a measurement contradicted what we expected. This page is the summary of those measurements: what was asked, what came back, and what changed because of it. Each item has the date it was measured. The full lab notebooks are kept privately; what is here is what they concluded.

A rule for reading this page: a finding that went against us is stated as plainly as one that went for us. Several of the most important ones are negative.

## 1. Asking a model the same thing twice does not give the same answer

*2026-09-20, a moderation decision with 108 situations, an ordinary chat model.*

Put the same situation to the same model twice and it answered the same way **75%** of the time (36 of 48 rows). Rows where the model said it was confident were not safer: only **14 of 20** high-confidence rows came back the same on a second ask. Two different models agreed with each other 69% of the time — barely less than one model agrees with itself.

**What changed:** freezing a decision into a table became the point. Once frozen, the same input always gets the same answer. It also changed how a chat model's answers are scored (next item).

## 2. A chat model's own confidence carries nothing; how often it agrees with itself does

*2026-09-20, two decisions, four independent passes, re-scored from saved per-ask records.*

Each situation was asked three times. Scoring rows by the model's self-reported confidence kept 12 of 48 rows actionable on one decision; scoring by **agreement** (all three asks gave the same answer) kept 28 of 48, and more of those reproduced on a repeat:

| | rows actionable | of those, same answer on a repeat |
|---|---|---|
| comment-hold, self-report | 12 / 48 | 11 / 12 = 92% |
| comment-hold, agreement | 28 / 48 | 27 / 28 = **96%** |
| refund-call, self-report | 34 / 60 | 34 / 34 = 100% |
| refund-call, agreement | 44 / 60 | 43 / 44 = **98%** |

The agreement rule was chosen on refund-call and then checked on comment-hold, which it had not seen. A bare majority (two of three) was also tried and is **not** safe: it passes on one decision and fails on the other (81%).

**What changed:** when your own model fills a table — in the page, on the command line, or through MCP — every situation is asked three times, and the confidence is the agreement rate. At the default 0.7 threshold only a unanimous row is acted on.

## 3. A calibrated decision model routes well — against a stated rule

*2026-09-20, a "should Mario jump" decision with 512 situations, filled by a typed decision model (Jev).*

When the scene described the rule plainly, the model matched the rule on 486 of 512 rows (95%), and **every** row it was confident about (≥ 0.7) was right: 337 of 337. Every disagreement sat below 0.7. With a vague scene it was confident on only 4% of rows — it was guessing, correctly flagging that it was guessing.

**What changed:** confidence became the router — confident rows are frozen, the rest go to a person (`review = 1`). But see item 5: matching a rule is not the same as matching a person.

## 4. Almost nothing people casually wish for fits in a circuit

*2026-09-20, 300 wishes for "a little gadget that helps with …", generated without telling the generator what a circuit is or what templates exist.*

| | count | share |
|---|---|---|
| deliverable (buttons in, lights and readouts out) | 9 | **3%** |
| the logic fits, but it needs sensors or actuators | 84 | 28% |
| a circuit cannot do it | 176 | 59% |
| unreadable | 25 | 8% |

What stopped them: text (230), lists (150), time (143), a person's identity (95), the network (68). People want applications and services, not a few gates.

**What changed:** the original positioning — "describe a behaviour, get a circuit" — was dropped as the front door. gatecraft is now for **one small decision inside a program you already have**, whose observations are already a few discrete codes. The sentence-to-circuit workbench is still there, for the things that are genuinely that small.

## 5. Every automated check can pass while the decision is wrong

*2026-09-21, six real decisions, each checked against twenty situations answered blind, without seeing the model's answers. **Who answered matters, so it is said first: the AI assistant running the measurement, acting as an independent judge — not the repository's owner, and not the model that filled the table. No person has answered these yet.***

In **two of the six**, the filling model disagreed with the blind answers exactly where it was most confident. Both passed the row-by-row proof, the independent Yosys proof, a repeat, and a high confidence — and then consistently did what the judge disagreed with.

What this does and does not show. It shows that a disagreement of this kind exists and that **only** the blind answers detect it: every other check passed. It does not show that the model is wrong by a human's standard — the judge is itself a model, and item 1 found two models agree about as often as one agrees with itself. The measurement that would settle it — the same questions answered by people who own these decisions — has not been run.

**What changed:** the twenty blind questions (anchors) became a gate rather than an option. Calibration can end in "do not delegate", and export refuses a decision calibrated that way. When an agent answers the anchors instead of a person, the result is labelled a consistency check and the exported module says nobody checked it.

## 6. The band is narrow

*2026-09-20 to 21, 55 real decisions.*

The tool pays off only where a short rule fails **and** the model settles most situations. Pre-registered before measuring: under 5% of decisions would mean "no product"; 5–20% "a narrow band". Result: **8 of 55 = 15%** (95% interval about 7–27%), and that is an upper bound — of the three band members later checked against blind answers (written by the same AI judge as item 5), one did not hold.

**What changed:** the README says plainly that who needs this is unproven.

## 7. A decision's size is limited by a person's attention, not by the circuit

*2026-09-21, measured price $0.0000204 per call.*

| bits | legal situations | cost to fill | time |
|---|---|---|---|
| 8 | 256 | $0.01 | 17 s |
| 12 | 4,096 | $0.08 | 4 min |
| 16 | 65,536 | $1.34 | 71 min |

Filling a large decision is cheap. What does not scale is the person: twenty blind answers over 65,536 situations are 256 times sparser than over 256, and those answers are the only check that catches item 5.

**What changed:** decisions are capped at 16 bits, and the docs argue against making them bigger.

## 8. A step that fails the same way every time is usually the pipeline

*2026-09-21 and 2026-09-23.*

Three times a model looked incapable and was not:

- Drafting rules returned zero rules for every decision. Cause: the whole codebook was sent and each call hit a three-minute timeout. A compact summary fixed it.
- A 7B local model's codebook drafts were rejected twice in a row for "code 2 does not fit in 1 bit". The meaning was right; the bit-width arithmetic was wrong. Widths are now computed from the codes, and every widening is reported.
- Rules that quoted their option names (`"retract_tool"`) were syntax errors, silently costing 5 of 24 decisions their rules.

**What changed:** before concluding "the model can't", check the pipeline.

## 9. Bugs the checks found in gatecraft itself

Stated because each one would have shipped a wrong answer with a clean certificate:

- *2026-09-23:* every exporter froze the table at the spec's threshold while the module's header named the calibrated one. Calibrating to 0.8 because the person disagreed at 0.7 still produced a module that acted on the 0.7–0.8 rows. Exports now freeze at the calibrated threshold and refuse any mismatch.
- *2026-09-23:* a refusal said "wrong where it is most confident" when the real reason was too few answers above any threshold. Refusals now say which: contradicted, or not enough evidence yet.
- *2026-09-23:* the check that flags buckets needing free text fired on every field of a decision about comments, because every description said the word "comment". It now looks for the act of reading, not the noun.

## How to read a number here

Every threshold above was written down before the data came in, including what result would count as failure. Where a result was reported after the fact, or a pre-registered criterion turned out to be badly written, the page says so rather than reporting the nicer number. See [method](method.md#pre-registration).
