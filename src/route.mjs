// Which shape is this sentence asking for, and what should its knobs be set to?
//
// This is the cheapest road from a sentence to a proven circuit, and the measurements say it
// is also the best one: a typed decision model picked the right template for ten of ten
// sentences, a 7B model for nine of ten, against thirty-five percent for writing the program
// from scratch. Choosing among a known list is a far smaller job than writing a program, and
// a wrong choice costs nothing - whatever is chosen is still compiled and proven on every
// row, and the person reads the sentence back before anything is built.
//
// Both halves are asked as questions with a fixed set of answers, so nothing here can invent
// a template that does not exist or a knob that is out of range: templateParams refuses those
// outright. The model narrows; the compiler decides.
import { TEMPLATES, templateById, templateParams } from "./templates.mjs";

// The fork: one of the shapes, or none of them. Every template describes itself so the list
// stays honest as the library grows.
export const forkQuestion = (lang = "zh") => ({
  instructions: lang === "zh" ? "这句话想要的是下面哪一种现成的小机器" : "Which of these ready-made machines is this asking for",
  criteria: {
    ...Object.fromEntries(TEMPLATES.map((t) => [t.id, t.blurb[lang] ?? t.blurb.en])),
    none: lang === "zh" ? "以上都不是，这句话要的是一台没有现成形状的机器" : "none of these; it wants a shape we do not have",
  },
});

// The same question as plain text, for a model that answers in words rather than in types.
export function forkPrompt(sentence, lang = "zh") {
  const q = forkQuestion(lang);
  const list = Object.entries(q.criteria).map(([id, text]) => `${id} = ${text}`).join("\n");
  return `${q.instructions}？

${list}

句子：${sentence}

只回答一个英文代号，就是上面等号左边那些词里的一个：${Object.keys(q.criteria).join(" / ")}
不要解释，不要翻译，不要标点，只回那一个词。`;
}

export function forkFromReply(reply, lang = "zh") {
  const text = String(reply ?? "").toLowerCase();
  const ids = Object.keys(forkQuestion(lang).criteria);
  // Take the first known name that appears: a small model wraps its answer in quotes, a full
  // stop, or a sentence, and none of that changes which shape it picked.
  const hit = ids
    .map((id) => ({ id, at: text.indexOf(id.toLowerCase()) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  return hit ? hit.id : null;
}

// The knobs: the numbers the person actually said. Asked separately from the shape, because a
// wrong shape and a wrong number fail differently and should not be one guess.
export function knobsPrompt(id, sentence, lang = "zh") {
  const template = templateById(id);
  if (!template) throw new Error(`unknown template ${JSON.stringify(id)}`);
  if (!template.params.length) return null;
  const knobs = template.params
    .map((p) => `  "${p.name}": <${p.min} 到 ${p.max}${p.step > 1 ? `，每 ${p.step} 一档` : ""}>   ${p.label[lang] ?? p.label.en}`)
    .join("\n");
  return `这句话要做的是「${template.title[lang] ?? template.title.en}」：${template.blurb[lang] ?? template.blurb.en}

它有这些旋钮，请按句子里说的填。句子里没说的，就不要写那一项。只回 JSON，不要解释。

{
${knobs}
}

句子：${sentence}`;
}

export function knobsFromReply(reply) {
  const text = String(reply ?? "");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Math.round(Number(v))]));
  } catch {
    return {};
  }
}

// Knobs the template will actually accept. Anything out of range, off its step or not a
// number is dropped back to the default rather than refused: the person sees every knob on
// the next screen and can move it, and a silently clamped knob would be worse than an obvious
// default. What must never happen is a value the compiler cannot prove, and templateParams is
// what guarantees that.
export function safeKnobs(id, wanted = {}) {
  const template = templateById(id);
  if (!template) throw new Error(`unknown template ${JSON.stringify(id)}`);
  const kept = {};
  const dropped = [];
  for (const p of template.params) {
    const value = wanted[p.name];
    try {
      templateParams(template, { [p.name]: value });
      if (value !== undefined) kept[p.name] = value;
    } catch {
      if (value !== undefined) dropped.push({ name: p.name, value, min: p.min, max: p.max, step: p.step });
    }
  }
  return { knobs: kept, dropped };
}
