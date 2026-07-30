import { renderTrace } from "./render.js";
import type { ReadTraceResult } from "./trace-file.js";

export interface FormatOptions {
  readonly color: boolean;
}

/**
 * Turns the result of reading a trace file into exactly the text `inspect`
 * prints — the ASCII tree, raw JSON, or a one-line error — with no opinion
 * about exit codes or how often it gets called.
 *
 * Shared between the one-shot render in `index.ts` and the repeated one in
 * `watch.ts`, so the two can never drift apart on wording or shape.
 */
export function formatInspection(
  result: ReadTraceResult,
  json: boolean,
  options: FormatOptions,
): string {
  if (!result.ok) return `loomtrace inspect: ${result.message}\n`;
  if (json) return JSON.stringify(result.trace, null, 2) + "\n";
  return renderTrace(result.trace, options);
}
