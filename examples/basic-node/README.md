# basic-node example

Minimal use of `@loomtrace/core` directly — no OpenTelemetry, no CLI, just
`.run()`/`.step()` around a made-up "answer a question" agent.

## Run it

From the repo root:

```bash
pnpm install
pnpm --filter basic-node-example start
```

This runs the agent once, prints the exact inspect command for its trace
(with the real trace id filled in), and writes the trace itself to
`.loomtrace/traces/<traceId>.json` — e.g.:

```bash
node ../../packages/cli/dist/cli.js inspect .loomtrace/traces/<traceId>.json
```

`loomtrace` isn't installed as a global command here (the package isn't
published to npm yet), so `npx loomtrace ...` won't find it — the CLI has to
be built (`pnpm --filter @loomtrace/cli build`, done automatically by the
root build) and invoked from its `dist/cli.js`, as above. See
[`packages/cli`](../../packages/cli) for other ways to run it.

## What it shows

- `tracer.run()` wrapping a top-level operation, with `input` set up front
- `tracer.step()` nesting through ambient context — no span threading through
  function signatures
- a step that throws and is caught by the caller: the step is recorded as
  failed, the run around it still finishes `"ok"`
- an optional step (`verify-discount-code`) that only exists on some runs —
  the trace tree reflects whatever the "model" decided to do, not a fixed
  shape
- `span.setOutput()` to record a result shaped differently from the
  callback's return value
