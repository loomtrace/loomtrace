/**
 * Writes finished traces to disk, one JSON file per trace.
 *
 * The intended reader is a human or `@loomtrace/cli`, poking around a
 * project's own working directory during development — not a production
 * sink. That shapes the choices below: files are pretty-printed, and a failed
 * write is left to loomtrace's normal `onError` reporting rather than
 * retried, exactly like any other destination.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { LoomDestination } from "./destination.js";
import type { SpanNode, TraceNode } from "../schema.js";

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
    await this.#writeFile(trace);
  }

  /**
   * Rewrites the whole file on every span, once there is a live viewer that
   * wants to see one before the run is finished — `write()` alone only ever
   * shows up here at the very end.
   *
   * The individual span is not consulted: it is already inside `trace`, which
   * is written whole each time, since the file is small enough during
   * development that rewriting it beats maintaining a diff.
   */
  async onSpanUpdate(_span: SpanNode, trace: TraceNode): Promise<void> {
    await this.#writeFile(trace);
  }

  /**
   * Writes via a temp file plus a rename rather than overwriting the target
   * directly, so a reader watching this file — `loomtrace inspect --watch`,
   * most likely — never opens it mid-write. A rename onto an existing name
   * replaces the directory entry in one step; a reader either still sees the
   * previous complete file or the new one, never a half-written one, no
   * matter how many times this runs while something is tailing it.
   */
  async #writeFile(trace: TraceNode): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const target = join(this.#dir, `${trace.id}.json`);
    const staging = `${target}.${randomUUID()}.tmp`;
    await writeFile(staging, JSON.stringify(trace, null, 2), "utf8");
    await rename(staging, target);
  }
}
