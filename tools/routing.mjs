// The two questions a shape-first product has to answer before it compiles anything:
//
//   the door - is this sentence one small machine, several, or not a machine at all?
//   the fork - which of our shapes is it?
//
// Both are multiple choice with a small, known set of answers, which is a much smaller job
// than writing the program. This file holds the questions, the ground truth and the scoring,
// so that every kind of model gets asked exactly the same thing: a typed decision model
// (tools/jev-route-eval.mjs) and an ordinary chat model (tools/route-eval.mjs).
//
// A wrong answer here is cheap: whatever shape is picked still writes a program that is
// compiled and proven on every row before anyone sees it, and the person still reads the
// sentence back. That is why a fast, fallible router is allowed to stand at the front.
import { SENTENCES } from "./muggle-eval.mjs";
import { FAMILIES, TEMPLATES, templateById } from "../src/templates.mjs";

export const DOOR = {
  instructions: "这句话描述的东西，能不能用一颗小电路做出来",
  criteria: {
    fits: "一颗小电路就够：几个开关或一个不大的数进去，一个判断、一个计数或一个灯出来，要记的东西也很少",
    split: "是电路能做的事，但一颗装不下：要好几个独立的部分，或者数太大",
    theatre: "电路做不了：要存文字、要联网、要账号、要真实时间，或者要跟别人同步",
  },
};

// Every template describes itself, so this list stays honest as the library grows.
export const fork = (lang = "zh") => ({
  instructions: "这句话想要的是下面哪一种现成的小机器",
  criteria: {
    ...Object.fromEntries(TEMPLATES.map((t) => [t.id, t.blurb[lang] ?? t.blurb.en])),
    none: "以上都不是，这句话要的是一台没有现成形状的机器",
  },
});


// The door, asked a second way: two yes/no questions with something concrete to look for,
// instead of one three-way judgement. A small model answered "one circuit holds this" to all
// twenty sentences when asked the three-way version, including the chat room.
export const DOOR_BINARY = {
  theatre: {
    instructions: "这句话要的东西，需不需要存文字、联网、账号、真实时间，或者跟别人同步",
    yes: "theatre",
  },
  split: {
    instructions: "这句话里是不是有好几台各管各的小机器（比如两个互不相干的计数器），而不是一台",
    yes: "split",
  },
};

// theatre wins over split: a chat room with two parts is still a chat room.
export const doorFromBinaries = ({ theatre, split }) => (theatre ? "theatre" : split ? "split" : "fits");

// The fork, asked in two steps: which kind, then which one of that kind.
export const familyQuestion = (lang = "zh") => ({
  instructions: "这句话想要的小机器，属于下面哪一类",
  criteria: {
    ...Object.fromEntries(Object.entries(FAMILIES).map(([id, label]) => [
      id,
      `${label[lang] ?? label.en}：${TEMPLATES.filter((t) => t.family === id).map((t) => t.blurb[lang] ?? t.blurb.en).join(" ")}`,
    ])),
    none: "以上都不是",
  },
});

export const memberQuestion = (family, lang = "zh") => ({
  instructions: `这句话想要的是这一类里的哪一个`,
  criteria: Object.fromEntries(TEMPLATES.filter((t) => t.family === family).map((t) => [t.id, t.blurb[lang] ?? t.blurb.en])),
});

export const familyOf = (id) => templateById(id)?.family ?? "none";

export const DOOR_TRUTH = SENTENCES.map(([sentence, verdict]) => [sentence, [verdict]]);

// Several ids are acceptable where two shapes both honestly fit the words.
export const FORK_TRUTH = [
  ["会员卡满十次送一杯，按一下盖一个章", ["quota", "counter"]],
  ["三个评委按下通过，两个以上就算过", ["vote"]],
  ["房间温度低于 20 度开暖气，高于 24 度关", ["thermostat"]],
  ["密码锁：按对四位数字才开", ["lock"]],
  ["两队比分板，各有加一分和减一分", ["scoreboard"]],
  ["红绿灯：红 3 拍、绿 3 拍、黄 1 拍", ["traffic"]],
  ["投币 5 毛买一瓶水，够了就出货并找零", ["vending"]],
  ["电梯：三层楼，按哪层去哪层", ["elevator"]],
  ["车位满了就亮红灯，有空位亮绿灯，最多 8 个车位", ["threshold"]],
  ["宠物喂食器：按一下出一份，一天最多五份", ["quota"]],
];

// The mark, written down before any model was asked: below this, a router cannot be the spine.
export const PASS = { door: 0.9, fork: 0.7 };

export const shapeName = (id) => templateById(id)?.title?.zh ?? (id === "none" ? "都不是" : id);

// Brier score against the answer that was actually right. 0 is perfect; 1 - 1/n is the score
// for spreading belief evenly over n answers, so it says whether the stated sureness is worth
// anything at all.
export const brier = (rows) => rows.reduce((sum, r) => sum + (1 - (r.p ?? 0)) ** 2, 0) / (rows.length || 1);

export function report(name, rows, mark) {
  const right = rows.filter((r) => r.right).length;
  const rate = right / (rows.length || 1);
  console.log(`\n${name}: ${right} / ${rows.length} 对（${(rate * 100).toFixed(0)}%，判据 ${(mark * 100).toFixed(0)}%）${rate >= mark ? " 过" : " 不过"}`);
  if (rows.some((r) => r.p !== undefined)) console.log(`  Brier: ${brier(rows).toFixed(3)}`);
  const edges = [0, 0.5, 0.7, 0.9, 1.01];
  for (const [i, low] of edges.slice(0, -1).entries()) {
    const high = edges[i + 1];
    const inside = rows.filter((r) => (r.confidence ?? 0) >= low && (r.confidence ?? 0) < high);
    if (inside.length) console.log(`  把握 ${low.toFixed(2)}–${high === 1.01 ? "1.00" : high.toFixed(2)}: ${inside.filter((r) => r.right).length}/${inside.length} 对`);
  }
  for (const r of rows.filter((r) => !r.right)) {
    console.log(`  错: ${r.sentence}\n       它说 ${r.said}${r.confidence === undefined ? "" : `（${r.confidence.toFixed(2)}）`}，应该是 ${r.want}`);
  }
  return rate >= mark;
}
