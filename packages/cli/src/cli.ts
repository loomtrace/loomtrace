#!/usr/bin/env node
import { parseInspectArgs, run } from "./index.js";
import { watchTrace } from "./watch.js";

const isTTY = Boolean(process.stdout.isTTY);
const color = isTTY && process.env.NO_COLOR === undefined;
const argv = process.argv.slice(2);

// `--watch` is a long-running mode with nowhere to fit in `run()`'s one
// CliResult, so it is handled here directly rather than through it.
const inspectArgs = argv[0] === "inspect" ? parseInspectArgs(argv.slice(1)) : undefined;

if (inspectArgs?.watch) {
  const stop = watchTrace(inspectArgs.path, {
    color,
    json: inspectArgs.json,
    onFrame: (frame) => {
      process.stdout.write(isTTY ? `\x1b[2J\x1b[H${frame}` : frame);
    },
  });
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
} else {
  const result = run(argv, { color });
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}
