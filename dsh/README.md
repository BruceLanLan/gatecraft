# dsh-gatecraft

Say what a circuit should do; get a NAND circuit proven on every input — inside DeepSeek Harness.

This is a thin carrier for [gatecraft](https://github.com/BruceLanLan/gatecraft), which is a standalone application in its own right (its own page, command line and local API). Installing this plugin adds a second way to reach the same compiler; nothing here is required to use gatecraft.

## What it adds

- **Tools for the agent.** `gatecraft_compile` compiles an expression program into a circuit and proves it on every input; `gatecraft_check` reads a program back in plain words and checks its own examples without compiling; `gatecraft_simulate` runs a compiled netlist on one set of inputs. The agent writes the program itself, so nothing here asks for an API key.
- **The page and the local API**, under `/gatecraft/` and `/gatecraft/api` on the harness's own web address.

## Install

```sh
dsh plugin --profile web add "link:/path/to/gatecraft/dsh"
```

Then add `dsh-gatecraft` to the profile's `dsh.profile.bundles` and restart `dsh web`.

The compiler itself is zero-dependency and lives in the gatecraft checkout this package links to.
