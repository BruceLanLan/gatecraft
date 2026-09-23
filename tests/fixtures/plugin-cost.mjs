// A plugin the tests load: one method and one route, plus a cleanup effect.
export const name = "cost";

export function apply(ctx) {
  ctx.method("of", ({ nand, depth }) => {
    if (!Number.isInteger(nand) || !Number.isInteger(depth)) throw new ctx.ApiError("bad_request", '"nand" and "depth" must be whole numbers');
    return { podCost: nand * depth ** 3 };
  });
  // builds on a built-in method
  ctx.method("ofProgram", async (params) => {
    const compiled = await ctx.api["compile.expr"](params);
    const c = compiled.certificate.circuit;
    return { name: compiled.name, nand: c.nand, depth: c.depth, podCost: c.podCost };
  });
  ctx.route("/cost/ping", "GET", (req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("cost plugin here\n");
  });
  ctx.effect(() => { globalThis.__costPluginDisposed = true; });
}
