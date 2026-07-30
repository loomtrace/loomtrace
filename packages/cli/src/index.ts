/**
 * @loomtrace/cli — programmatic entry point.
 */

import { formatInspection } from "./format.js";
import { readTraceFile } from "./trace-file.js";

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

/** The positional `<path>` and flags pulled out of `inspect`'s argv, in any order. */
export interface InspectArgs {
  readonly path: string;
  readonly json: boolean;
  readonly watch: boolean;
}

/** `undefined` when `args` has no positional `<path>` — the one thing `inspect` cannot proceed without. */
export function parseInspectArgs(args: readonly string[]): InspectArgs | undefined {
  const path = args.find((arg) => !arg.startsWith("-"));
  if (!path) return undefined;
  return { path, json: args.includes("--json"), watch: args.includes("--watch") };
}

function inspect(args: readonly string[], options: CliOptions): CliResult {
  const parsed = parseInspectArgs(args);
  if (!parsed) {
    return { exitCode: 1, stdout: `loomtrace inspect: missing <path>\n\n${usage()}` };
  }

  if (parsed.watch) {
    // A `run()` call returns exactly one result and nothing keeps this process
    // alive to produce a second one, so `--watch` cannot be answered here.
    // `cli.ts` intercepts it before ever calling `run()` and drives
    // `watchTrace()` against the real terminal instead — reaching this means
    // `run()` was called directly, some other way.
    return {
      exitCode: 1,
      stdout: "loomtrace inspect --watch: only supported through the loomtrace binary\n",
    };
  }

  const result = readTraceFile(parsed.path);
  return { exitCode: result.ok ? 0 : 1, stdout: formatInspection(result, parsed.json, options) };
}

function usage(): string {
  return [
    "loomtrace — terminal viewer for AI agent traces",
    "",
    "Usage:",
    "  loomtrace inspect <path>            inspect a trace JSON file",
    "  loomtrace inspect <path> --json     print the trace as raw JSON",
    "  loomtrace inspect <path> --watch    redraw as the file changes",
    "",
  ].join("\n");
}
