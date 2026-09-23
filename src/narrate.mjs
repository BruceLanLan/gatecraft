// Run the thing in front of the person, in words.
//
// Everything else in this compiler checks that the circuit matches the PROGRAM. Nothing checks
// that the program matches what the person wanted - and that gap is not theoretical: four
// templates shipped with the circuit proven on every row and the behaviour plainly wrong (a
// lock that closed itself on a wrong entry, a coin machine whose change was always zero, a
// feeder that fed forever). The proof was right every time. The sentence was wrong.
//
// A table of rows does not catch that; people do not read tables. What catches it is watching
// it move: press this, then this, and here is what happens. So this plays the circuit for a
// few ticks and says what happened in the same plain words the rest of the page uses, for the
// person to agree with or reject before anything is built on top of it.
//
// It invents nothing. Every number here comes from runStep on the program itself.
import { runStep } from "./expr.mjs";

const press = (program) => program.inputs.find((i) => i.width === 1) ?? program.inputs[0] ?? null;

// A short script: press the first button a few times, leaving everything else alone. Simple on
// purpose - a story a person can follow beats a thorough one they skip.
export function play(program, { ticks = 4, hold = {} } = {}) {
  const button = press(program);
  const state = Object.fromEntries((program.states ?? []).map((s) => [s.name, 0]));
  const steps = [];
  for (let tick = 1; tick <= ticks; tick += 1) {
    const inputs = Object.fromEntries(program.inputs.map((i) => [i.name, i.name === button?.name ? 1 : Number(hold[i.name] ?? 0)]));
    const out = runStep(program, { ...state, ...inputs });
    steps.push({ tick, inputs, outputs: out.outputs, before: { ...state }, after: { ...out.next } });
    Object.assign(state, out.next);
  }
  return { button: button?.name ?? null, steps };
}

const joinOutputs = (program, outputs, lang) => {
  const parts = program.outputs.map((o) => {
    const value = outputs[o.name];
    if (o.width === 1) return `${o.name} ${value ? (lang === "zh" ? "亮" : "on") : lang === "zh" ? "灭" : "off"}`;
    return `${o.name} ${lang === "zh" ? "是" : "="} ${value}`;
  });
  return parts.join(lang === "zh" ? "，" : ", ");
};

// The story, one line per press, plus a last line about what it still remembers. Lines that
// say exactly the same thing as the line before are folded together, because "nothing changed"
// three times in a row is noise, and "按了三下都没反应" is the signal.
export function narrate(program, { ticks = 4, lang = "zh" } = {}) {
  const { button, steps } = play(program, { ticks });
  if (!button) return [];
  const lines = [];
  let same = 0;
  for (const step of steps) {
    const said = joinOutputs(program, step.outputs, lang);
    const previous = lines.at(-1);
    if (previous && previous.said === said) {
      same += 1;
      previous.text = lang === "zh"
        ? `按第 ${previous.tick} 到 ${step.tick} 下：都是 ${said}`
        : `Presses ${previous.tick} to ${step.tick}: still ${said}`;
      continue;
    }
    same = 0;
    lines.push({
      tick: step.tick,
      said,
      text: lang === "zh" ? `按第 ${step.tick} 下：${said}` : `Press ${step.tick}: ${said}`,
    });
  }
  const last = steps.at(-1);
  if (last && program.states?.length) {
    const remembered = program.states.map((s) => `${s.name} ${lang === "zh" ? "是" : "="} ${last.after[s.name]}`).join(lang === "zh" ? "，" : ", ");
    lines.push({ tick: null, said: null, text: lang === "zh" ? `这时候它记着：${remembered}` : `It now remembers: ${remembered}` });
  }
  return lines;
}

// Does pressing the button ever change anything? A machine that ignores its only button is
// almost always a misunderstanding rather than a design, and it is worth saying so out loud
// before the person has to notice it themselves.
export function everMoves(program, { ticks = 8 } = {}) {
  const { steps } = play(program, { ticks });
  if (steps.length < 2) return true;
  const first = JSON.stringify(steps[0].outputs);
  return steps.some((s) => JSON.stringify(s.outputs) !== first);
}
