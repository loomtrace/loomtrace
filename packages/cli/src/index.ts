/**
 * @loomtrace/cli — programmatic entry point.
 */

/** Result of a CLI invocation. Extended in item 6.1. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Testable entry point: never touches `process` directly. */
export function run(argv: readonly string[]): CliResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { exitCode: 0, stdout: usage() };
  }
  return {
    exitCode: 1,
    stdout: `loomtrace: unknown command "${argv[0]}"\n\n${usage()}`,
  };
}

function usage(): string {
  return [
    "loomtrace — terminal viewer for AI agent traces",
    "",
    "Usage:",
    "  loomtrace inspect <path>   inspect a trace JSON file (not implemented yet)",
    "",
  ].join("\n");
}
