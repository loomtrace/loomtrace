# @loomtrace/core

Tracing protocol for AI agent frameworks: `run`/`step` API, span tree, destinations.

Meant to be embedded **inside** an agent framework as an implementation
detail — the framework author constructs and owns the `LoomTrace` instance,
and the framework's own users only ever see a flag like
`trace: "local" | "silent"`. See the [root README](../../README.md#embed-me-inside-your-framework)
for that pattern end to end.

## Install

```bash
pnpm add @loomtrace/core
```

## Usage

```ts
import { LoomTrace } from "@loomtrace/core";

const tracer = new LoomTrace({ destination: "local" });

async function answerQuestion(question: string): Promise<string> {
  return tracer.run("answer-question", { input: { question } }, async (span) => {
    const context = await tracer.step("retrieve-context", () => retrieve(question));
    const answer = await tracer.step("call-llm", () => callLlm(question, context));
    span.setOutput({ answer });
    return answer;
  });
}

await answerQuestion("What's the weather in Tallinn?");
await tracer.flush();
```

- `.run(name, fn)` opens a trace, runs `fn` inside its root span, and hands
  the finished trace to `destination` once `fn` settles. Nesting a `.run()`
  inside another run of the same tracer doesn't start a second trace — it
  becomes a child span of the enclosing one, so a sub-agent call stays part
  of the run that made it.
- `.step(name, fn)` records a child of whichever span is currently active —
  found through `AsyncLocalStorage`, not passed by hand — so steps nest
  correctly through `await`, `Promise.all`, and callback boundaries without
  passing a span down every call chain. Called outside a `.run()`, it just
  invokes `fn` and returns its value: a missing trace, not a broken program.
- A thrown or rejected callback marks its span `"error"` and is always
  re-thrown — loomtrace observes control flow, it never participates in it.
- `destination` defaults to `"silent"`: writing files into a user's project
  is not a decision a transitive dependency gets to make unasked. `"local"`
  writes each finished trace as JSON to `.loomtrace/traces/<traceId>.json`,
  readable with [`@loomtrace/cli`](../cli)'s `inspect` command. Passing an
  object implementing `LoomDestination` sends traces anywhere else.
- `tracer.flush()` waits for every trace produced so far to reach its
  destination; call it at your framework's own teardown point. loomtrace
  never hooks process exit itself — see `DESIGN.md`, section 5.4.

## Design

The trace JSON schema and the full API/destination contract are documented
in [`DESIGN.md`](./DESIGN.md), including the reasoning behind the choices
above and a table of deferred questions.

## License

[MIT](./LICENSE)
