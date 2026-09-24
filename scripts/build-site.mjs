// Builds the website: the same page `npm run ui` serves, as static files.
//
// The page needs ui/, the browser-safe modules in src/ it imports, and examples/. With no server
// behind it, the decision view runs the API's methods in the browser itself (see ui/decide.mjs)
// and fills through the free trial or the visitor's own model; nothing here holds a key.
//
//   node scripts/build-site.mjs        -> out/site/
//   cd site && npx wrangler deploy     -> gatecraft.fun
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join("out", "site");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ["ui", "src", "examples"]) cpSync(dir, join(out, dir), { recursive: true });
writeFileSync(join(out, "_redirects"), "/ /ui/ 302\n");
// A browser that ignores _redirects still lands on the tool.
writeFileSync(join(out, "index.html"), '<!doctype html><meta charset="utf-8"><title>gatecraft</title><meta property="og:title" content="gatecraft - freeze one decision, prove it on every input"><meta property="og:image" content="https://gatecraft.fun/ui/og.png"><meta name="twitter:card" content="summary_large_image"><meta http-equiv="refresh" content="0; url=/ui/"><a href="/ui/">gatecraft</a>\n');
console.log(`built ${out}`);
