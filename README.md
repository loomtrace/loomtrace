# loomtrace

Embeddable tracing for AI agent frameworks.

`loomtrace` is a TypeScript library meant to be embedded **inside** an agent
framework as an implementation detail. The framework author wraps `LoomTrace`
in their own class, and the agent developer downstream only ever sees a flag
like `trace: "local" | "silent"`.

## Principles

- **No monkey-patching** of third-party SDKs. An explicit instance
  (`new LoomTrace(...)`) plus an optional OpenTelemetry bridge, nothing else.
- **`destination` is an abstraction from day one**: `"silent" | "local" | LoomDestination`.
  A cloud destination can be added later without a breaking change.
- **The trace JSON schema is open and versioned** — it is a public contract.

## Embed me inside your framework

`loomtrace` is not meant to be a dependency an agent developer installs and
calls directly. It's meant to disappear inside whatever agent framework you
maintain: you construct and own the `LoomTrace` instance, and your own users
see only a flag you already expose — something like `trace: "local" | "silent"`.

```ts
import { LoomTrace, type DestinationSpec } from "@loomtrace/core";

interface MyFrameworkOptions {
  // ... your framework's own options ...
  trace?: "local" | "silent";
}

export class MyFramework {
  #tracer: LoomTrace;

  constructor(options: MyFrameworkOptions = {}) {
    // "silent" is the default on both sides: a transitive dependency doesn't
    // get to write files into a user's project without being asked.
    const destination: DestinationSpec = options.trace ?? "silent";
    this.#tracer = new LoomTrace({ destination });
  }

  async runAgent(task: string): Promise<string> {
    return this.#tracer.run("agent-run", { input: { task } }, async (span) => {
      const plan = await this.#tracer.step("plan", () => this.#plan(task));
      const result = await this.#tracer.step("execute", () => this.#execute(plan));
      span.setOutput(result);
      return result;
    });
  }

  async #plan(task: string): Promise<string[]> {
    /* ... */
    return [];
  }

  async #execute(plan: string[]): Promise<string> {
    /* ... */
    return "";
  }

  async shutdown(): Promise<void> {
    await this.#tracer.shutdown();
  }
}
```

The developer using `MyFramework` never imports `@loomtrace/core`, never sees
a span, and never sees this library's name — they just pass `trace: "local"`
and get a JSON trace under `.loomtrace/traces/`, inspectable with
`npx loomtrace inspect`. If your framework's agent calls happen to run
through OpenTelemetry already (Vercel AI SDK and others emit `gen_ai.*`
spans this way), bridge those instead with
[`@loomtrace/otel`](./packages/otel) rather than instrumenting by hand — see
[`examples/otel-vercel-ai`](./examples/otel-vercel-ai).

## Packages

| Package | Description |
| --- | --- |
| [`@loomtrace/core`](./packages/core) | Tracing protocol, `run`/`step` API, span tree, destinations |
| [`@loomtrace/otel`](./packages/otel) | OpenTelemetry spans → loomtrace trace format |
| [`@loomtrace/cli`](./packages/cli) | `npx loomtrace inspect` — ASCII trace viewer for the terminal |

## Development

pnpm workspaces + Turborepo. Requires Node.js >= 20 and pnpm (enable it with
`corepack enable pnpm`).

```bash
pnpm install        # install dependencies for every package
pnpm build          # build all packages (tsup: esm + cjs + d.ts)
pnpm test           # run the test suites (vitest)
pnpm test:watch     # vitest in watch mode across the whole monorepo
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit in every package
pnpm ci             # lint + typecheck + build + test — what CI runs
```

### Layout

```
loomtrace/
├── packages/
│   ├── core/       @loomtrace/core
│   ├── otel/       @loomtrace/otel
│   └── cli/        @loomtrace/cli
├── tsconfig.base.json    shared strict TypeScript config
├── turbo.json            pipeline: build → test, with caching
├── vitest.config.ts      monorepo-level vitest config (test.projects)
└── pnpm-workspace.yaml   workspace + catalog of shared tooling versions
```

### Versioning and releases

Package versions are managed with
[changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset          # describe a change (pick packages and bump type)
pnpm version-packages   # apply changesets: bump versions + write CHANGELOGs
pnpm release            # build and publish to npm
```

## License

[MIT](./LICENSE)
