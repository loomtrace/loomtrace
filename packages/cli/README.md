# @loomtrace/cli

Terminal viewer for loomtrace traces: `npx loomtrace inspect <path>`.

Reads a trace JSON file — the kind [`@loomtrace/core`](../core)'s
`LocalDestination` writes to `.loomtrace/traces/<traceId>.json` — and renders
it as a colored ASCII tree, one line per span.

## Install

Nothing to install for occasional use:

```bash
npx loomtrace inspect .loomtrace/traces/<traceId>.json
```

Or add it to a project:

```bash
pnpm add -D @loomtrace/cli
```

## Usage

```bash
loomtrace inspect <path>            # colored ASCII tree
loomtrace inspect <path> --json     # raw trace JSON, for piping elsewhere
loomtrace inspect <path> --watch    # redraw as the file changes
```

Each span line shows a status icon, its name, latency (colored green/yellow/red
by threshold), and — when present in `metadata` — token usage or cost. A
failed span appends its error; a cancelled one is marked `(cancelled)`. Color
is on when stdout is a TTY and off when `NO_COLOR` is set or output is piped.

A span whose `parentId` doesn't resolve to any span in the file becomes a
root of its own in the tree, rather than being silently dropped — useful for
inspecting a trace that's still being written to.

## License

[MIT](./LICENSE)
