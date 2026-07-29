# @loomtrace/otel

Bridge between OpenTelemetry spans and the loomtrace trace format.

`LoomTraceSpanProcessor` is a standard `SpanProcessor` — register it on any
`TracerProvider` and it buffers a trace's spans as they end, then hands the
whole trace to a `LoomDestination` from `@loomtrace/core` once the trace's
root span closes. It has no dependency on what produced the spans: anything
that emits OTel spans through the provider it's registered on works, and it
additionally recognizes the `gen_ai.*` / `ai.*` attribute conventions Vercel
AI SDK's OTel bridge (`@ai-sdk/otel`) emits, to fill in a span's `type`,
`input`, and `output` beyond the generic mapping.

## Install

```bash
pnpm add @loomtrace/otel @loomtrace/core @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node
```

`@opentelemetry/api` and `@opentelemetry/sdk-trace-base` are peer
dependencies — bring your own `TracerProvider`
(`@opentelemetry/sdk-trace-node` for a Node.js process).

## Usage

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LocalDestination } from "@loomtrace/core";
import { LoomTraceSpanProcessor } from "@loomtrace/otel";

const provider = new NodeTracerProvider({
  spanProcessors: [
    new LoomTraceSpanProcessor({ destination: new LocalDestination() }),
  ],
});
provider.register();
```

From here, any span your application creates through this provider is
recorded: a genuine root (no locally-visible parent) becomes a trace, every
descendant becomes one of its spans. With Vercel AI SDK, that means
registering its telemetry integration against the same provider:

```ts
import { OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry } from "ai";

registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer("gen_ai") }));
```

so that a call like

```ts
await generateText({
  model: "openai/gpt-5.4",
  prompt: "...",
  telemetry: { functionId: "recipe-generator" },
});
```

turns into a loomtrace trace, with the model call and any tool invocations
as its spans.

## Options

```ts
new LoomTraceSpanProcessor({
  destination, // a LoomDestination from @loomtrace/core; omitted = record nothing
  onError,     // (error: Error) => void — defaults to one console.warn per instance
});
```

The delivered trace matches `@loomtrace/core`'s `TraceNode`/`SpanNode` types
— any reader built against that package can load it.

## License

[MIT](./LICENSE)
