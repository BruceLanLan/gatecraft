#!/usr/bin/env node
// A sentence to an expression program, through a model on the user's own account.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { run } from "../src/cli.mjs";
import { askModel, describePrompt, PROVIDERS } from "../src/describe.mjs";

const USAGE = `
Usage:
  node scripts/describe.mjs "SENTENCE" --name NAME [--provider anthropic|openai] [--model M]
  node scripts/describe.mjs "SENTENCE" --prompt-only

Asks a language model, with your own API key, to write the behaviour as an expression
program, checks the program, and writes NAME.expr.json for compile-expr. gatecraft pays for
no model: the key is read from an environment variable and sent only to the provider.
With --prompt-only it prints the prompt instead, to paste into any assistant.

Options:
  --provider P     one of: ${Object.keys(PROVIDERS).join(", ")} (default anthropic)
  --model M        model name (default for anthropic: ${PROVIDERS.anthropic.model})
  --base-url URL   API address (https://, or http:// on this computer for a local server)
  --key-env VAR    environment variable holding the key
                   (default ${PROVIDERS.anthropic.keyEnv} or ${PROVIDERS.openai.keyEnv})
  --spec FILE      where to write the program (default NAME.expr.json)
  --prompt-only    print the prompt and ask nothing

The compiled circuit is proven to match the program, not the sentence: read the program.
`;

run(USAGE, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      provider: { type: "string", default: "anthropic" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "key-env": { type: "string" },
      spec: { type: "string" },
      "prompt-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const sentence = positionals.join(" ");
  if (values["prompt-only"]) {
    console.log(describePrompt(sentence));
    return;
  }
  if (!values.name || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(values.name)) throw new Error("--name must be a short lowercase slug, e.g. --name max6");
  const provider = PROVIDERS[values.provider];
  if (!provider) throw new Error(`--provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  const keyEnv = values["key-env"] ?? provider.keyEnv;
  const key = process.env[keyEnv];
  if (!key) throw new Error(`set ${keyEnv} to your API key (it is sent only to the provider), or use --prompt-only`);
  const result = await askModel({
    provider: values.provider,
    baseUrl: values["base-url"],
    model: values.model,
    key,
    sentence,
    onAttempt: (n) => { if (n > 1) console.error(`the first program was rejected; asking again (try ${n})`); },
  });
  const file = values.spec ?? `${values.name}.expr.json`;
  writeFileSync(file, `${JSON.stringify(result.spec, null, 2)}\n`);
  console.log(`${file}: written by the model${result.attempts > 1 ? ` on try ${result.attempts}` : ""}. Read it, then:`);
  console.log(`  node scripts/compile-expr.mjs --spec ${file} --name ${values.name}`);
});
