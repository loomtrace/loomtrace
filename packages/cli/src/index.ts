/**
 * @loomtrace/cli — programmatic entry point.
 */

import { readTraceFile } from "./trace-file.js";
import { renderTrace } from "./render.js";

/** Result of a CLI invocation. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface CliOptions {
  /** Whether to emit ANSI color codes. Decided by `cli.ts` from the real terminal; defaults to off for callers (tests) that don't care. */
  readonly color: boolean;
}

const DEFAULT_OPTIONS: CliOptions = { color: false };

/** Testable entry point: never touches `process` directly. */
export function run(argv: readonly string[], options: CliOptions = DEFAULT_OPTIONS): CliResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { exitCode: 0, stdout: usage() };
  }
  if (argv[0] === "inspect") {
    return inspect(argv.slice(1), options);
  }
  return {
    exitCode: 1,
    stdout: `loomtrace: unknown command "${argv[0]}"\n\n${usage()}`,
  };
}

function inspect(args: readonly string[], options: CliOptions): CliResult {
  const path = args.find((arg) => !arg.startsWith("-"));
  const json = args.includes("--json");

  if (!path) {
    return { exitCode: 1, stdout: `loomtrace inspect: missing <path>\n\n${usage()}` };
  }

  const result = readTraceFile(path);
  if (!result.ok) {
    return { exitCode: 1, stdout: `loomtrace inspect: ${result.message}\n` };
  }

  if (json) {
    return { exitCode: 0, stdout: JSON.stringify(result.trace, null, 2) + "\n" };
  }
  return { exitCode: 0, stdout: renderTrace(result.trace, options) };
}

function usage(): string {
  return [
    "loomtrace — terminal viewer for AI agent traces",
    "",
    "Usage:",
    "  loomtrace inspect <path>           inspect a trace JSON file",
    "  loomtrace inspect <path> --json    print the trace as raw JSON",
    "",
  ].join("\n");
}
