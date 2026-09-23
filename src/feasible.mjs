// Can a circuit hold this at all? Decided by code, not by a model.
//
// Asking a model "could a small circuit do this" does not work, at any size we tried: a 3B
// answers "yes" to all twenty sentences including a chat room, a 7B does the same, and even a
// calibrated typed model let a translator through. The published ceiling for this kind of
// out-of-scope judgement is about two thirds right, so the answer is not a better model.
//
// The answer is to stop asking. A circuit holds a fixed number of bits and nothing else, so
// "can it be built" is a property of the INPUTS AND OUTPUTS, and that property is decidable.
// The model does the easy half - name what goes in and what comes out, in the person's own
// words, with a kind on each - and this file does the half that must never be wrong.
//
// A chat room needs to hold a message: unbounded text. A to-do list needs a list that grows.
// A translator's input is any sentence in a language. None of them can be written as a fixed
// number of bits, so none of them can be a circuit, and no amount of model confidence changes
// that. The refusal names the thing that made it impossible, which is also what the person
// needs to hear.
//
// The gate can only be as good as the naming it is given, and that is the part to measure: the
// model can still call a message "a number". But naming what goes in is a far smaller job than
// judging feasibility, and when the naming is right the verdict cannot be wrong.

// What a signal can be. Only the first two can live in a circuit; the rest are named so that a
// refusal can say which one it was, in words the person used.
export const KINDS = {
  bit: { finite: true, zh: "开关（开或关）", en: "a switch (on or off)" },
  number: { finite: true, zh: "一个有范围的数", en: "a number with a range" },
  // The unbounded kinds carry the swap that usually rescues the sentence. A plain no measured
  // worst of the refusal styles; naming what could be used instead measured best, and for
  // these three there really is a standard substitution - the pet feeder wanting to know the
  // date is the common case, and a button for "a new day" is how every such machine does it.
  text: { finite: false, zh: "一段文字", en: "a piece of text", instead: "如果只是几种固定选项，可以改成几个按钮或一个编号", swap: (name) => `把「${name}」改成几个固定选项的按钮` },
  list: { finite: false, zh: "一份会变长的清单", en: "a list that grows", instead: "如果只需要知道有几条，可以改成一个计数", swap: (name) => `把「${name}」改成只数个数，不存清单` },
  time: { finite: false, zh: "真实时间（几点、几号、过了多少分钟）", en: "real time (a clock or a date)", instead: "电路不知道今天几号，但可以给它一个「新的一天」按钮，或者一个「走一拍」的节拍", swap: (name) => `把「${name}」改成一个手按的「新的一天」按钮` },
  network: { finite: false, zh: "要联网取的东西", en: "something fetched over the network" },
  person: { finite: false, zh: "账号或某个人的身份", en: "an account or someone's identity" },
};

// How a signal meets the world. The kinds above say whether a value FITS in a circuit; these
// say whether we can actually deliver it. A hundred real wishes made the difference obvious:
// "帮我剥蒜" and "一打呼就让他翻个身" name perfectly good bits, fit in a circuit, and are
// impossible for us - one needs hands, the other needs to hear. Nothing in the kinds could
// see that, so those wishes sailed through the gate and were only caught by accident.
//
// A circuit we can deliver takes its inputs from things a person works (a button, a dial) and
// puts its outputs where a person looks (a lamp, a number). Anything that has to sense the
// world or act on it needs hardware we do not have, and saying so is not a refusal of the
// logic - the logic is fine - it is an honest account of what would still be missing.
export const WIRING = {
  button: { here: true, zh: "人按的按钮或开关" },
  dial: { here: true, zh: "人拨的一个数" },
  lamp: { here: true, zh: "给人看的灯" },
  display: { here: true, zh: "给人看的读数" },
  sensor: { here: false, zh: "要去感知真实世界（听声音、测温度、看有没有人）" },
  actuator: { here: false, zh: "要去动真实世界（转动、加热、发声、喷东西）" },
};

export const MAX_BITS = 20;

const bitsFor = (min, max) => Math.max(1, Math.ceil(Math.log2(Math.floor(max) - Math.ceil(min) + 1)));

const list = (value) => (Array.isArray(value) ? value : []);

// The whole verdict, from a named list of signals. Pure: no model, no network, no randomness.
//
// Three outcomes, not two, and the split is the point. Measured on two models, lumping them
// together turned away half the buildable sentences; separated, the refusals stay perfect and
// most of the rest turn into one short question:
//
//   ok   - build it.
//   no   - NO circuit can do this, ever. Only unbounded kinds land here, so this verdict is a
//          proof rather than a judgement, and that is the whole reason the gate exists.
//   ask  - a circuit can do this once one more thing is known: how far the number goes, or a
//          narrower range, or what it should show. Not a refusal - a missing number.
export function feasibility(signals, { maxBits = MAX_BITS } = {}) {
  const impossible = [];
  const questions = [];
  const hardware = [];
  const where = { inputs: "输入", remembers: "要记住的", outputs: "输出" };
  let bits = 0;

  for (const key of ["inputs", "remembers", "outputs"]) {
    for (const raw of list(signals?.[key])) {
      const name = String(raw?.name ?? "").trim() || "(没名字)";
      const kind = String(raw?.kind ?? "").trim();
      const known = KINDS[kind];
      if (!known) {
        questions.push({ name, where: key, kind, why: "unknown-kind", says: `${where[key]}「${name}」没说清是什么东西` });
        continue;
      }
      if (!known.finite) {
        impossible.push({ name, where: key, kind, why: "unbounded", says: `${where[key]}「${name}」是${known.zh}，电路装不下` });
        continue;
      }
      const wiring = WIRING[String(raw?.wiring ?? "").trim()];
      if (wiring && !wiring.here) {
        // The logic is buildable; the machine around it is not, at least not by us.
        hardware.push({ name, where: key, kind, wiring: raw.wiring, says: `${where[key]}「${name}」${wiring.zh}` });
      }
      if (kind === "number") {
        const min = Number(raw.min);
        const max = Number(raw.max);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
          // A threshold nobody put a number on ("as warm as feels nice") lands here. It is not
          // impossible, it is unspecified, and the person is the one who knows.
          questions.push({ name, where: key, kind, why: "no-range", says: `${where[key]}「${name}」从几到几？` });
          continue;
        }
        if (key !== "outputs") bits += bitsFor(min, max);
      } else if (key !== "outputs") {
        bits += 1;
      }
    }
  }

  if (!list(signals?.inputs).length && !list(signals?.remembers).length) {
    questions.push({ name: "", where: "inputs", kind: "", why: "nothing-in", says: "它要靠什么动起来？按钮、开关，还是一个读数？" });
  }
  if (!list(signals?.outputs).length) {
    questions.push({ name: "", where: "outputs", kind: "", why: "nothing-out", says: "它要显示什么？" });
  }
  if (!impossible.length && !questions.length && bits > maxBits) {
    // Width is negotiable: the same sentence fits or does not depending on how big the numbers
    // are allowed to get, and only the person knows which reading they meant.
    questions.push({ name: "", where: "inputs", kind: "", why: "too-wide", says: `这样算下来要 ${bits} 位，超过了 ${maxBits} 位——把数的范围放小一点就装得下，最大到几就够用？` });
  }

  // A refusal is about the signals as named, not about the wish behind them, and sometimes a
  // stand-in rescues it: a machine cannot know the date, but "a new day" can be a button.
  //
  // This used to offer a stand-in whenever every blocker had one in principle, and three
  // hundred real wishes showed how badly that reads: "把「梦境捕捉器」改成只数个数" and
  // "把「儿子说的话」改成几个按钮" were being offered with a straight face. Having a stand-in
  // in principle is not the same as the wish surviving it.
  //
  // So the offer is now limited to the one case that has actually been shown to work: the
  // blockers are all about real time, and nothing else about the machine needs hardware we
  // do not have. The pet feeder's "five a day" is exactly that, and it lands on a template.
  // Everything else gets a plain refusal, which is the honest answer.
  const swaps = impossible
    .filter((p) => KINDS[p.kind]?.swap)
    .map((p) => ({ ...p, instead: KINDS[p.kind].instead, says: KINDS[p.kind].swap(p.name) }));
  const swappable = impossible.length > 0 && hardware.length === 0 && impossible.every((p) => p.kind === "time");
  const problems = [...impossible, ...questions];
  // Order matters and it is not arbitrary. Impossible outranks everything: there is no point
  // asking about a range on a machine that can never exist. Needing hardware outranks a
  // question for the same reason - "how high does the score go" is a silly thing to ask about
  // a machine that would first have to hear the upstairs drill. Measured: without this order
  // a third of the sensor wishes were landing in "just one question away".
  return {
    ok: problems.length === 0 && hardware.length === 0,
    // The logic fits but something outside this page would have to sense or move the world.
    needsHardware: impossible.length === 0 && hardware.length > 0,
    hardware,
    no: impossible.length > 0,
    ask: impossible.length === 0 && hardware.length === 0 && questions.length > 0,
    swappable,
    swaps,
    bits,
    impossible,
    questions,
    problems,
  };
}

// What to say to the person. A plain no is the worst of the refusal styles that have been
// measured, so a real refusal names the thing that blocked it and points at what can be done
// instead; a question asks for the one thing that is missing and nothing else, which is the
// form that measured best in the programming-by-example work.
export function refusalWords(verdict, { nearest = null } = {}) {
  if (verdict.ok) return "";
  if (verdict.no) {
    const first = verdict.impossible[0];
    const rest = verdict.impossible.length > 1 ? `（还有 ${verdict.impossible.length - 1} 处同样的问题）` : "";
    const swap = KINDS[first.kind]?.instead;
    return `这个小电路做不了：${first.says}${rest}${swap ? `\n${swap}` : ""}${nearest ? `\n能做的是这一类：${nearest}` : ""}`;
  }
  // One question at a time: the first one, on its own, with no table around it.
  return verdict.questions[0].says;
}

// The model's half of the job, and deliberately the easy half: name the signals, do not judge.
//
// The framing matters more than the wording, and the first version got it wrong. Asked plainly
// what goes in and out, a 7B model names the thing in the WORLD rather than the signal on the
// wire: a scoreboard's score came back as "text", a lift's buttons as "a list", three washing
// machine settings as "a list", and the hint in a guessing game as "text". Every one of those
// is a switch or a small number once it is on a panel. So the question is now about the panel:
// what buttons does this machine have, what does it show. That is the same information, asked
// where the answer is a signal rather than a concept - and it leaves the unbounded kinds for
// the cases that really are unbounded, which is what the gate needs to stay sound.
export function signalsPrompt(sentence) {
  const text = String(sentence ?? "").trim();
  if (!text) throw new Error("describe the behaviour in a sentence first");
  return `Imagine the thing below built as a small machine sitting on a desk, with a front panel. Describe its panel: what a person can press or turn, what it shows, and what it must still know between presses. Do not judge whether it is possible, do not design the insides, do not write code. Reply with JSON only.

{
  "inputs":    [ { "name": "<what the person would call this control>", "kind": "<kind>", "wiring": "<wiring>", "min": <number>, "max": <number> } ],
  "remembers": [ { "name": "...", "kind": "...", "min": ..., "max": ... } ],
  "outputs":   [ { "name": "...", "kind": "...", "wiring": "<wiring>", "min": ..., "max": ... } ]
}

"kind" is exactly one of:
  bit     - a button, a switch, a lamp: pressed or not, lit or not
  number  - a dial or a number display; you MUST give "min" and "max"
  text    - the machine would have to hold WORDS someone typed or spoke
  list    - the machine would have to hold a collection that keeps growing
  time    - the machine would have to know the real clock or calendar
  network - the machine would have to reach something else to answer
  person  - the machine would have to know who someone is, or an account

"wiring" says how that signal meets the world - inputs are one of:
  button  - a person presses or flips it
  dial    - a person turns it to a number
  sensor  - something has to MEASURE the world for this: hear it, see it, weigh it, feel it

and outputs are one of:
  lamp    - a person looks at a light
  display - a person reads a number
  actuator- something has to ACT on the world: move, heat, spray, make a sound, unlock

Be literal about this. "It notices my husband snoring" starts with a sensor, whatever else it
does. "It peels the garlic" ends in an actuator. Saying so is not a criticism of the wish.

How to choose:
- A choice among N named settings (three wash cycles, three floors, red/green/yellow) is a
  "number" from 0 to N-1, or N separate buttons - it is not a list.
- A score, a count, a temperature, a price, an amount of change is a "number" with a range.
- Several lamps are several "bit" outputs. A reading someone looks at is one "number" output.
- Use "text", "list", "time", "network" or "person" only when the machine itself would have to
  hold or reach that thing. Saying it honestly is the job: a chat room really does hold words.
- "remembers" is what it must still know on the next press; leave it empty if nothing.
- If the person gave no numbers for a range, leave min and max out rather than inventing them.

Behaviour: ${text}`;
}

// Read the signal list out of a reply that may be fenced or chatty.
export function signalsFromReply(reply) {
  const text = String(reply ?? "");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the reply contains no JSON object");
  const parsed = JSON.parse(body.slice(start, end + 1));
  return {
    inputs: list(parsed.inputs),
    remembers: list(parsed.remembers ?? parsed.state),
    outputs: list(parsed.outputs),
  };
}
