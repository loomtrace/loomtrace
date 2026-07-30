# @loomtrace/cli

## 0.1.0

### Minor Changes

- Initial public release.

  - `@loomtrace/core` — tracing protocol for AI agent frameworks: `LoomTrace.run`/`.step`, span tree, `silent`/`local` destinations, versioned trace schema.
  - `@loomtrace/otel` — OpenTelemetry `SpanProcessor` bridge, with built-in mapping for the Vercel AI SDK's `gen_ai.*`/`ai.*` span attributes.
  - `@loomtrace/cli` — `npx loomtrace inspect <path>`, including `--watch` for live-updating traces and `--json` for scripting.

### Patch Changes

- Updated dependencies
  - @loomtrace/core@0.1.0
