// Templates: a starting point for someone who does not want to write a sentence at all.
//
// A template is a shape with a few knobs. Turning the knobs writes the program - inputs,
// memory, outputs and its own worked examples - and the compiler then proves it on every row
// like any other program. Nothing here needs a model or a key, so the shortest honest path
// from "I want a thing" to "here is a proven circuit and an app" runs through this file.
//
// A template earns its place only if the circuit underneath is genuinely the right tool: a
// handful of bits in, a decision or a count out. Anything that wants text, storage, timing in
// seconds or the network belongs in the page around the circuit, not in the gates.
const bitsFor = (max) => Math.max(1, Math.ceil(Math.log2(max + 1)));
const int = (name, label, { min, max, step = 1, def }) => ({ name, label, type: "int", min, max, step, default: def });

// "family" groups the shapes the way a person would ask for them - counting, judging,
// remembering, going in order, showing - so a chooser can ask "which kind" before "which one".
// It is a label only: it changes no circuit, no program and no proof.
export const FAMILIES = {
  count: { en: "Counting", zh: "数数" },
  judge: { en: "Judging", zh: "判断" },
  remember: { en: "Remembering", zh: "记住" },
  sequence: { en: "Going in order", zh: "按拍走" },
  show: { en: "Showing", zh: "显示" },
};

export const TEMPLATES = [
  {
    id: "vote",
    family: "judge",
    title: { en: "A vote", zh: "投票器" },
    blurb: { en: "Each person presses yes or no; it passes when most say yes.", zh: "每人按下同意或反对，多数同意就通过。" },
    params: [int("people", { en: "People", zh: "几个人" }, { min: 3, max: 9, step: 2, def: 3 })],
    sentence: ({ people }) => ({
      en: `${people} people vote, one bit each; it passes when most say yes`,
      zh: `${people} 个人投票，每人一位，多数同意就通过`,
    }),
    build({ people }) {
      const names = Array.from({ length: people }, (_, i) => `v${i + 1}`);
      const need = Math.floor(people / 2) + 1;
      const given = (ones) => Object.fromEntries(names.map((name, i) => [name, i < ones ? 1 : 0]));
      return {
        inputs: Object.fromEntries(names.map((name) => [name, 1])),
        outputs: { pass: { width: 1, expr: `${names.join(" + ")} >= ${need}` } },
        examples: [
          { given: given(0), expect: { pass: 0 } },
          { given: given(need - 1), expect: { pass: 0 } },
          { given: given(need), expect: { pass: 1 } },
          { given: given(people), expect: { pass: 1 } },
        ],
      };
    },
  },
  {
    id: "counter",
    family: "count",
    title: { en: "A button counter", zh: "按钮计数器" },
    blurb: { en: "Each press adds one; after the last number it starts over.", zh: "每按一下加 1，数到最后一个数就从头开始。" },
    params: [int("top", { en: "Counts up to", zh: "数到几" }, { min: 3, max: 15, def: 9 })],
    sentence: ({ top }) => ({
      en: `A button counter: each press adds 1, after ${top} it goes back to 0`,
      zh: `一个按钮计数器：每按一下加 1，到 ${top} 之后回到 0`,
    }),
    build({ top }) {
      const width = bitsFor(top);
      return {
        inputs: { press: 1 },
        state: { count: { width, next: `press ? (count == ${top} ? 0 : count + 1) : count` } },
        outputs: { digit: { width, expr: "count" }, last: { width: 1, expr: `count == ${top}` } },
        examples: [
          { given: { press: 1, count: 0 }, expect: { digit: 0, last: 0 }, then: { count: 1 } },
          { given: { press: 0, count: 2 }, expect: { digit: 2 }, then: { count: 2 } },
          { given: { press: 1, count: top }, expect: { digit: top, last: 1 }, then: { count: 0 } },
        ],
      };
    },
  },
  {
    id: "lamp",
    family: "remember",
    title: { en: "A press-to-toggle lamp", zh: "按一下亮的灯" },
    blurb: { en: "Press once for on, press again for off. It remembers.", zh: "按一下亮，再按一下灭。它自己记住状态。" },
    params: [],
    sentence: () => ({ en: "A lamp: press once to turn it on, press again to turn it off", zh: "一个灯：按一下亮，再按一下灭" }),
    build() {
      return {
        inputs: { press: 1 },
        state: { on: { width: 1, next: "press ? !on : on" } },
        outputs: { light: { width: 1, expr: "on" } },
        examples: [
          { given: { press: 1, on: 0 }, expect: { light: 0 }, then: { on: 1 } },
          { given: { press: 1, on: 1 }, expect: { light: 1 }, then: { on: 0 } },
          { given: { press: 0, on: 1 }, expect: { light: 1 }, then: { on: 1 } },
        ],
      };
    },
  },
  {
    id: "compare",
    family: "judge",
    title: { en: "Compare two numbers", zh: "比两个数" },
    blurb: { en: "Shows the larger one, and whether they are equal.", zh: "输出较大的那个，以及它们是否相等。" },
    params: [int("bits", { en: "Bits each", zh: "每个数几位" }, { min: 2, max: 8, def: 4 })],
    sentence: ({ bits }) => ({
      en: `Two ${bits}-bit numbers: output the larger one, and whether they are equal`,
      zh: `两个 ${bits} 位数，输出较大的那个，以及它们是否相等`,
    }),
    build({ bits }) {
      const top = 2 ** bits - 1;
      return {
        inputs: { a: bits, b: bits },
        outputs: { larger: { width: bits, expr: "a > b ? a : b" }, same: { width: 1, expr: "a == b" } },
        examples: [
          { given: { a: 0, b: top }, expect: { larger: top, same: 0 } },
          { given: { a: top, b: 0 }, expect: { larger: top, same: 0 } },
          { given: { a: 1, b: 1 }, expect: { larger: 1, same: 1 } },
        ],
      };
    },
  },
  {
    id: "threshold",
    family: "judge",
    title: { en: "An over-the-limit alarm", zh: "超过就报警" },
    blurb: { en: "A reading comes in; it says whether it is above the limit, and by how much.", zh: "读数进来，它说有没有超过上限、超了多少。" },
    params: [
      int("bits", { en: "Reading bits", zh: "读数几位" }, { min: 3, max: 8, def: 7 }),
      int("limit", { en: "Limit", zh: "上限" }, { min: 1, max: 200, def: 30 }),
    ],
    sentence: ({ limit }) => ({
      en: `When the reading goes above ${limit}, raise the alarm, and show how far above it is`,
      zh: `读数超过 ${limit} 就报警，并显示超出多少`,
    }),
    build({ bits, limit }) {
      const top = 2 ** bits - 1;
      const cap = Math.min(limit, top);
      return {
        inputs: { reading: bits },
        outputs: {
          over: { width: 1, expr: `reading > ${cap}` },
          above: { width: bits, expr: `reading > ${cap} ? reading - ${cap} : 0` },
        },
        examples: [
          { given: { reading: cap }, expect: { over: 0, above: 0 } },
          { given: { reading: Math.min(cap + 1, top) }, expect: { over: cap + 1 <= top ? 1 : 0, above: cap + 1 <= top ? 1 : 0 } },
          { given: { reading: top }, expect: { over: top > cap ? 1 : 0, above: top > cap ? top - cap : 0 } },
        ],
      };
    },
  },
  {
    id: "streak",
    family: "count",
    title: { en: "Three in a row", zh: "连续几次就报警" },
    blurb: { en: "Counts how many times in a row the signal arrives; a gap starts the count again.", zh: "数信号连续来了几次，中间断一次就重新数。" },
    params: [int("times", { en: "Times in a row", zh: "连续几次" }, { min: 2, max: 7, def: 3 })],
    sentence: ({ times }) => ({
      en: `Sound an alarm after ${times} in a row; a gap starts the count again`,
      zh: `连续 ${times} 次就报警，中间断一次就重新数`,
    }),
    build({ times }) {
      const width = bitsFor(times);
      return {
        inputs: { signal: 1 },
        state: { run: { width, next: `signal ? (run == ${times} ? ${times} : run + 1) : 0` } },
        outputs: { alarm: { width: 1, expr: `run == ${times}` }, sofar: { width, expr: "run" } },
        examples: [
          { given: { signal: 1, run: 0 }, expect: { alarm: 0, sofar: 0 }, then: { run: 1 } },
          { given: { signal: 1, run: times - 1 }, expect: { alarm: 0 }, then: { run: times } },
          { given: { signal: 0, run: times }, expect: { alarm: 1 }, then: { run: 0 } },
        ],
      };
    },
  },
  {
    id: "digit",
    family: "show",
    title: { en: "A digit display", zh: "数码管" },
    blurb: { en: "Turns a number into the seven strokes that draw it.", zh: "把一个数变成数码管的七根笔画。" },
    params: [],
    sentence: () => ({
      en: "Take a number 0 to 9 and light the seven strokes of a digit display",
      zh: "给一个 0 到 9 的数，点亮数码管的七根笔画",
    }),
    build() {
      // The seven strokes, in the usual a..g order, for 0..9; 10..15 stay dark.
      const strokes = [
        [1, 1, 1, 1, 1, 1, 0], [0, 1, 1, 0, 0, 0, 0], [1, 1, 0, 1, 1, 0, 1], [1, 1, 1, 1, 0, 0, 1],
        [0, 1, 1, 0, 0, 1, 1], [1, 0, 1, 1, 0, 1, 1], [1, 0, 1, 1, 1, 1, 1], [1, 1, 1, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 0, 0, 1, 1],
      ];
      const names = ["a", "b", "c", "d", "e", "f", "g"];
      const outputs = {};
      names.forEach((name, k) => {
        const on = strokes.map((row, digit) => (row[k] ? digit : null)).filter((d) => d !== null);
        outputs[name] = { width: 1, expr: on.map((d) => `n == ${d}`).join(" || ") };
      });
      const expect = (digit) => Object.fromEntries(names.map((name, k) => [name, strokes[digit][k]]));
      return {
        inputs: { n: 4 },
        outputs,
        examples: [
          { given: { n: 0 }, expect: expect(0) },
          { given: { n: 1 }, expect: expect(1) },
          { given: { n: 8 }, expect: expect(8) },
          { given: { n: 10 }, expect: Object.fromEntries(names.map((name) => [name, 0])) },
        ],
      };
    },
  },
  {
    id: "traffic",
    family: "sequence",
    title: { en: "A traffic light", zh: "红绿灯" },
    blurb: { en: "Each tick moves it on: red, green, yellow, red again.", zh: "每走一拍换一个灯：红、绿、黄、再回到红。" },
    params: [],
    sentence: () => ({
      en: "A traffic light: each tick moves it on from red to green to yellow and back to red",
      zh: "红绿灯：每走一拍从红到绿到黄，再回到红",
    }),
    build() {
      return {
        inputs: { go: 1 },
        state: { phase: { width: 2, next: "go ? (phase == 2 ? 0 : phase + 1) : phase" } },
        outputs: {
          red: { width: 1, expr: "phase == 0" },
          green: { width: 1, expr: "phase == 1" },
          yellow: { width: 1, expr: "phase == 2" },
        },
        examples: [
          { given: { go: 1, phase: 0 }, expect: { red: 1, green: 0, yellow: 0 }, then: { phase: 1 } },
          { given: { go: 1, phase: 1 }, expect: { green: 1 }, then: { phase: 2 } },
          { given: { go: 1, phase: 2 }, expect: { yellow: 1 }, then: { phase: 0 } },
          { given: { go: 0, phase: 1 }, expect: { green: 1 }, then: { phase: 1 } },
        ],
      };
    },
  },
  {
    id: "scoreboard",
    family: "count",
    title: { en: "A two-team scoreboard", zh: "两队记分牌" },
    blurb: { en: "Each team has a plus and a minus; a score stops at 0 and at the top.", zh: "每队一个加分一个减分，到 0 和封顶就不再动。" },
    params: [int("top", { en: "Highest score", zh: "最高分" }, { min: 3, max: 15, def: 9 })],
    sentence: ({ top }) => ({
      en: `Two teams, each with a plus and a minus button, scores from 0 to ${top}`,
      zh: `两队比分板，各有加一分和减一分，分数从 0 到 ${top}`,
    }),
    build({ top }) {
      const width = bitsFor(top);
      const step = (score, up, down) =>
        `(${up} && ${score} < ${top}) ? ${score} + 1 : ((${down} && ${score} > 0) ? ${score} - 1 : ${score})`;
      const press = (given) => ({ a_up: 0, a_down: 0, b_up: 0, b_down: 0, ...given });
      return {
        inputs: { a_up: 1, a_down: 1, b_up: 1, b_down: 1 },
        state: {
          a: { width, next: step("a", "a_up", "a_down") },
          b: { width, next: step("b", "b_up", "b_down") },
        },
        outputs: { home: { width, expr: "a" }, away: { width, expr: "b" }, ahead: { width: 1, expr: "a > b" } },
        examples: [
          { given: press({ a_up: 1, a: 0, b: 0 }), expect: { home: 0, away: 0, ahead: 0 }, then: { a: 1, b: 0 } },
          { given: press({ a_down: 1, a: 0, b: 2 }), expect: { home: 0, away: 2, ahead: 0 }, then: { a: 0, b: 2 } },
          { given: press({ a_up: 1, b_up: 1, a: top, b: 0 }), expect: { home: top, away: 0, ahead: 1 }, then: { a: top, b: 1 } },
        ],
      };
    },
  },
  {
    id: "thermostat",
    family: "remember",
    title: { en: "A thermostat", zh: "温控开关" },
    blurb: {
      en: "The heat comes on below the low mark and goes off above the high one; in between it stays as it was.",
      zh: "低于下限开暖气，高于上限关，中间维持原样——这一格「维持原样」就是它必须有记忆的原因。",
    },
    params: [
      int("low", { en: "Turn on below", zh: "低于几度开" }, { min: 1, max: 40, def: 20 }),
      int("span", { en: "Degrees before it turns off", zh: "高多少度才关" }, { min: 1, max: 20, def: 4 }),
    ],
    sentence: ({ low, span }) => ({
      en: `Turn the heat on below ${low} degrees and off above ${low + span}`,
      zh: `房间温度低于 ${low} 度开暖气，高于 ${low + span} 度关`,
    }),
    build({ low, span }) {
      const high = low + span; // at most 60, so a 6-bit reading (0..63) always holds it
      return {
        inputs: { temp: 6 },
        state: { heating: { width: 1, next: `temp < ${low} ? 1 : (temp > ${high} ? 0 : heating)` } },
        outputs: { heat: { width: 1, expr: "heating" }, cold: { width: 1, expr: `temp < ${low}` } },
        examples: [
          { given: { temp: low - 1, heating: 0 }, expect: { heat: 0, cold: 1 }, then: { heating: 1 } },
          { given: { temp: high + 1, heating: 1 }, expect: { heat: 1, cold: 0 }, then: { heating: 0 } },
          { given: { temp: low, heating: 1 }, expect: { heat: 1, cold: 0 }, then: { heating: 1 } },
          { given: { temp: low, heating: 0 }, expect: { heat: 0, cold: 0 }, then: { heating: 0 } },
        ],
      };
    },
  },
  {
    id: "lock",
    family: "remember",
    title: { en: "A code lock", zh: "密码锁" },
    blurb: { en: "Dial a number and press enter; the right one opens it, and it stays open until you reset it.", zh: "拨到一个数按确认，对了就开，按复位才关。" },
    params: [
      int("bits", { en: "Code bits", zh: "密码几位" }, { min: 3, max: 8, def: 6 }),
      int("code", { en: "The code", zh: "密码是多少" }, { min: 0, max: 255, def: 42 }),
    ],
    sentence: ({ bits, code }) => {
      const secret = Math.min(code, 2 ** bits - 1);
      return {
        en: `A lock: press enter and it opens when the dial reads ${secret}; reset closes it`,
        zh: `密码锁：拨到 ${secret} 按确认才开，按复位关上`,
      };
    },
    build({ bits, code }) {
      const secret = Math.min(code, 2 ** bits - 1);
      const wrong = secret === 0 ? 1 : 0;
      return {
        inputs: { dial: bits, enter: 1, reset: 1 },
        // A wrong entry does nothing at all: only the right number opens it, only reset shuts it.
        state: { open: { width: 1, next: `reset ? 0 : ((enter && dial == ${secret}) ? 1 : open)` } },
        outputs: { unlocked: { width: 1, expr: "open" }, right: { width: 1, expr: `enter && dial == ${secret}` } },
        examples: [
          { given: { dial: secret, enter: 1, reset: 0, open: 0 }, expect: { unlocked: 0, right: 1 }, then: { open: 1 } },
          { given: { dial: wrong, enter: 1, reset: 0, open: 0 }, expect: { unlocked: 0, right: 0 }, then: { open: 0 } },
          { given: { dial: wrong, enter: 1, reset: 0, open: 1 }, expect: { unlocked: 1, right: 0 }, then: { open: 1 } },
          { given: { dial: 0, enter: 0, reset: 1, open: 1 }, expect: { unlocked: 1, right: 0 }, then: { open: 0 } },
          { given: { dial: 0, enter: 0, reset: 0, open: 1 }, expect: { unlocked: 1, right: 0 }, then: { open: 1 } },
        ],
      };
    },
  },
  {
    id: "elevator",
    family: "sequence",
    title: { en: "A small lift", zh: "小电梯" },
    blurb: { en: "Press a floor and it moves one floor each tick until it gets there.", zh: "按哪层就一拍一层地开过去，到了就停。" },
    params: [int("floors", { en: "Floors", zh: "几层楼" }, { min: 3, max: 4, def: 3 })],
    sentence: ({ floors }) => ({
      en: `A lift with ${floors} floors: press a floor and it moves one floor a tick until it arrives`,
      zh: `${floors} 层楼的电梯：按哪层就一拍一层地开过去，到了就停`,
    }),
    build({ floors }) {
      const width = bitsFor(floors - 1);
      const calls = Array.from({ length: floors }, (_, i) => `call${i + 1}`);
      // The newest button wins, lowest floor first; with no button the lift keeps its goal.
      const goal = calls.reduceRight((rest, name, i) => `${name} ? ${i} : (${rest})`, "goal");
      const pressed = (which = -1, state = {}) => ({
        ...Object.fromEntries(calls.map((name, i) => [name, i === which ? 1 : 0])),
        ...state,
      });
      return {
        inputs: Object.fromEntries(calls.map((name) => [name, 1])),
        state: {
          at: { width, next: "at < goal ? at + 1 : (at > goal ? at - 1 : at)" },
          goal: { width, next: goal },
        },
        outputs: {
          floor: { width, expr: "at" },
          moving: { width: 1, expr: "at != goal" },
          up: { width: 1, expr: "at < goal" },
        },
        examples: [
          { given: pressed(floors - 1, { at: 0, goal: 0 }), expect: { floor: 0, moving: 0, up: 0 }, then: { at: 0, goal: floors - 1 } },
          { given: pressed(-1, { at: 0, goal: floors - 1 }), expect: { floor: 0, moving: 1, up: 1 }, then: { at: 1, goal: floors - 1 } },
          { given: pressed(-1, { at: floors - 1, goal: 0 }), expect: { floor: floors - 1, moving: 1, up: 0 }, then: { at: floors - 2, goal: 0 } },
          { given: pressed(-1, { at: 1, goal: 1 }), expect: { floor: 1, moving: 0, up: 0 }, then: { at: 1, goal: 1 } },
        ],
      };
    },
  },
  {
    id: "vending",
    family: "count",
    title: { en: "A coin machine", zh: "投币机" },
    blurb: { en: "Coins add up; when there is enough it hands over the goods and the change.", zh: "投币累加，够了就出货并找零，然后清零。" },
    params: [int("price", { en: "Small coins per item", zh: "几个五毛一瓶" }, { min: 2, max: 7, def: 3 })],
    sentence: ({ price }) => ({
      en: `A drink costs ${price} small coins; a big coin is worth two, and it gives the change back`,
      zh: `一瓶水 ${price} 个五毛：投五毛或一块都行，够了就出货并找零`,
    }),
    build({ price }) {
      const width = bitsFor(price);
      // A machine that only takes exact coins never gives change, so there is a coin worth two.
      const credit = `balance + small + 2 * big`;
      const changeWidth = bitsFor(2 ** width - 1 + 3 - price);
      return {
        inputs: { small: 1, big: 1 },
        state: { balance: { width, next: `${credit} >= ${price} ? 0 : ${credit}` } },
        outputs: {
          serve: { width: 1, expr: `${credit} >= ${price}` },
          change: { width: changeWidth, expr: `${credit} >= ${price} ? ${credit} - ${price} : 0` },
          paid: { width, expr: "balance" },
        },
        examples: [
          { given: { small: 1, big: 0, balance: 0 }, expect: { serve: 0, change: 0, paid: 0 }, then: { balance: 1 } },
          { given: { small: 0, big: 1, balance: price - 2 }, expect: { serve: 1, change: 0, paid: price - 2 }, then: { balance: 0 } },
          { given: { small: 0, big: 1, balance: price - 1 }, expect: { serve: 1, change: 1, paid: price - 1 }, then: { balance: 0 } },
          { given: { small: 0, big: 0, balance: 1 }, expect: { serve: 0, change: 0, paid: 1 }, then: { balance: 1 } },
        ],
      };
    },
  },
  {
    id: "quota",
    family: "count",
    title: { en: "A daily allowance", zh: "定量发放" },
    blurb: {
      en: "Each press hands out one, up to the day's limit, and then no more until it is reset.",
      zh: "按一下发一份，发满当天的份额就不再发，复位算新的一天。",
    },
    params: [int("perDay", { en: "Portions a day", zh: "一天几份" }, { min: 2, max: 7, def: 5 })],
    sentence: ({ perDay }) => ({
      en: `Press to hand out one portion, at most ${perDay} a day; a reset starts a new day`,
      zh: `按一下出一份，一天最多 ${perDay} 份，复位算新的一天`,
    }),
    build({ perDay }) {
      const width = bitsFor(perDay);
      // The point of this one is that it stops. A counter that wraps would feed the pet forever.
      return {
        inputs: { press: 1, reset: 1 },
        state: { count: { width, next: `reset ? 0 : ((press && count < ${perDay}) ? count + 1 : count)` } },
        outputs: {
          served: { width, expr: "count" },
          full: { width: 1, expr: `count == ${perDay}` },
          gives: { width: 1, expr: `press && count < ${perDay}` },
        },
        examples: [
          { given: { press: 1, reset: 0, count: 0 }, expect: { served: 0, full: 0, gives: 1 }, then: { count: 1 } },
          { given: { press: 1, reset: 0, count: perDay }, expect: { served: perDay, full: 1, gives: 0 }, then: { count: perDay } },
          { given: { press: 0, reset: 1, count: perDay }, expect: { served: perDay, full: 1, gives: 0 }, then: { count: 0 } },
        ],
      };
    },
  },
];

export const templateById = (id) => TEMPLATES.find((template) => template.id === id) ?? null;

// The knob values a template starts with.
export const templateDefaults = (template) => Object.fromEntries(template.params.map((p) => [p.name, p.default]));

// Knob values, checked. A value outside its range, or off its step, is refused with the
// reason: a template must never hand the compiler something it cannot prove.
export function templateParams(template, given = {}) {
  const params = {};
  for (const p of template.params) {
    const value = given[p.name] ?? p.default;
    if (!Number.isInteger(value)) throw new Error(`${p.name} must be a whole number`);
    if (value < p.min || value > p.max) throw new Error(`${p.name} must be ${p.min}..${p.max}`);
    if ((value - p.min) % p.step !== 0) throw new Error(`${p.name} must be ${p.min}, ${p.min + p.step}, ${p.min + 2 * p.step}…`);
    params[p.name] = value;
  }
  return params;
}

// A template plus its knobs: the program to compile, and the sentence that describes it.
export function fromTemplate(id, given = {}, lang = "en") {
  const template = templateById(id);
  if (!template) throw new Error(`unknown template ${JSON.stringify(id)}`);
  const params = templateParams(template, given);
  const sentence = template.sentence(params);
  return {
    id,
    params,
    spec: template.build(params),
    sentence: sentence[lang] ?? sentence.en,
    sentences: sentence,
    title: template.title,
    blurb: template.blurb,
  };
}
