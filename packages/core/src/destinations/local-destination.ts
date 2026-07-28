/**
 * Writes finished traces to disk, one JSON file per trace.
 *
 * Item 4.2. The intended reader is a human or `@loomtrace/cli`, poking around
 * a project's own working directory during development — not a production
 * sink, which is what `"cloud"` will be for later. That shapes the choices
 * below: files are pretty-printed, and a failed write is left to loomtrace's
 * normal `onError` reporting rather than retried, exactly like any other
 * destination (DESIGN 5.1).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { LoomDestination } from "./destination.js";
import type { TraceNode } from "../schema.js";

export interface LocalDestinationOptions {
  /**
   * Where trace files are written.
   *
   * Resolved against `process.cwd()` when relative, so the default lands next
   * to wherever the process was started rather than next to this package.
   * Defaults to `.loomtrace/traces`.
   */
  dir?: string;
}

/**
 * `destination: "local"` writes here with the default directory; pass an
 * instance instead — `new LocalDestination({ dir: "..." })` — to change it.
 *
 * Each trace becomes `<dir>/<trace.id>.json`. The directory is created
 * (recursively, tolerating that it may already exist) before every write
 * rather than once at construction time, so a directory removed mid-process —
 * or never granted to exist in the first place — heals on the next trace
 * instead of failing forever.
 */
export class LocalDestination implements LoomDestination {
  readonly name = "local";

  readonly #dir: string;

  constructor(options: LocalDestinationOptions = {}) {
    this.#dir = resolve(process.cwd(), options.dir ?? ".loomtrace/traces");
  }

  async write(trace: TraceNode): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(
      join(this.#dir, `${trace.id}.json`),
      JSON.stringify(trace, null, 2),
      "utf8",
    );
  }
}
