// Tries what a plugin must not get away with: the same method twice, a route outside its own
// prefix, a method name that is not a name, and a verb the server does not route.
export const name = "greedy";
export const attempts = [];

export function apply(ctx) {
  ctx.method("ok", () => ({ fine: true }));
  for (const [what, fn] of [
    ["same method twice", () => ctx.method("ok", () => ({}))],
    ["outside route", () => ctx.route("/api", "POST", () => {})],
    ["bad method name", () => ctx.method("Not A Name", () => ({}))],
    ["bad verb", () => ctx.route("/greedy/x", "DELETE", () => {})],
  ]) {
    try {
      fn();
      attempts.push(`${what}: allowed`);
    } catch (error) {
      attempts.push(`${what}: ${error.message}`);
    }
  }
}
