# otel-vercel-ai example

Tracing a Vercel AI SDK agent with `@loomtrace/otel` — no `.run()`/`.step()`
calls anywhere near the agent code, no changes to how `generateText()` is
called at all.

## Run it

From the repo root:

```bash
pnpm install
pnpm --filter otel-vercel-ai-example start
```

This runs a small weather agent once — it calls a `getWeather` tool, then
answers using the tool's result — and prints the exact inspect command for
its trace, e.g.:

```bash
node ../../packages/cli/dist/cli.js inspect .loomtrace/traces/<traceId>.json
```

The agent's model is `MockLanguageModelV4` from `ai/test`, so this runs with
no API key and no network call. Point `model` at a real provider (e.g.
`openai("gpt-5.4")` from `@ai-sdk/openai`) to trace real calls — nothing about
the tracing setup below changes.

## What it shows

- `LoomTraceSpanProcessor` registered on a `NodeTracerProvider`, alongside
  `@ai-sdk/otel`'s own telemetry integration on the same provider — that's
  the entire integration
- a multi-step tool-calling loop (`stopWhen: stepCountIs(4)`): the model
  calls `getWeather`, the AI SDK feeds the result back in as the next step,
  and the model answers using it
- the resulting trace tree: one root span for the whole `generateText()` call,
  an `"llm"`-typed span per model call, a `"tool"`-typed span for the tool
  execution, and a step span per loop iteration — all inferred from the
  `gen_ai.*` attributes the AI SDK's OTel bridge already emits, not from
  anything this example adds

## Why a bridge instead of a `@loomtrace/vercel-ai-sdk` package

loomtrace doesn't ship SDK-specific integration packages, and doesn't
monkey-patch third-party SDKs. Vercel AI SDK already emits OpenTelemetry
spans describing its own model and tool calls; `@loomtrace/otel` only needs
to listen on the same `TracerProvider` and convert whatever it sees. The same
approach works for any other OTel-instrumented library, without loomtrace
knowing it exists.
