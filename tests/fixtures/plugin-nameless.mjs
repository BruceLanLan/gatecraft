// No name export, and an apply that would register something.
export function apply(ctx) {
  ctx.method("nope", () => ({}));
}
