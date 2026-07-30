import { watch as watchFs } from "node:fs";

import { formatInspection } from "./format.js";
import { readTraceFile } from "./trace-file.js";

export interface WatchTraceOptions {
  readonly color: boolean;
  readonly json: boolean;
  /** Called with each frame to display — the caller decides how: clear and redraw a real terminal, collect frames in a test. */
  readonly onFrame: (frame: string) => void;
  /**
   * Observes `path` for changes and calls `onChange` after each one. Returns a
   * function that stops observing.
   *
   * Defaults to `fs.watch`. Overridable because a real filesystem watcher's
   * timing is not something a test can wait on deterministically — a test
   * calls `onChange` itself instead.
   */
  readonly watchFile?: (path: string, onChange: () => void) => () => void;
}

function defaultWatchFile(path: string, onChange: () => void): () => void {
  const watcher = watchFs(path, onChange);
  return () => watcher.close();
}

/**
 * Renders `path` once immediately, then again after every change to the file,
 * for `loomtrace inspect <path> --watch`. Returns a function that stops
 * watching.
 *
 * A destination that rewrites its file on every span — `LocalDestination`,
 * once given an `onSpanUpdate` — does so via a temp file and a rename, so a
 * read landing mid-write here always sees a previous complete file or the
 * next one, never a truncated one. Reading a destination that does not take
 * that care can still land on a partial write; that shows up here as one
 * frame with a JSON parse error, corrected on the next change event.
 */
export function watchTrace(path: string, options: WatchTraceOptions): () => void {
  const render = (): void => {
    options.onFrame(formatInspection(readTraceFile(path), options.json, options));
  };

  render();
  return (options.watchFile ?? defaultWatchFile)(path, render);
}
