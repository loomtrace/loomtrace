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
