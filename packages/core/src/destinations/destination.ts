/**
 * Where finished traces go.
 *
 * A destination is the one part of loomtrace that someone else is expected to
 * implement: `"silent"` and `"local"` ship here, `"cloud"` comes later, and a
 * framework embedding loomtrace may well want to route traces into its own
 * logging pipeline instead. So this file is a contract, not just a signature —
 * the guarantees in both directions are written out in `DESIGN.md`, section
 * 5.1.
 *
 * Types only, like `schema.ts` and `api.ts`. `SilentDestination`
 * (`silent-destination.ts`) and `LocalDestination` (`local-destination.ts`)
 * implement it, items 4.1 and 4.2.
 */

import type { SpanNode, TraceNode } from "../schema.js";

/**
 * A sink for finished traces.
 *
 * `write` is the only required method, so the smallest possible destination is
 * `{ write() {} }`. A destination that does not buffer should not have to
 * implement two empty promises to satisfy the interface, which is why the
 * lifecycle methods are optional.
 *
 * Note what is *not* here: there is no return value a destination can use to
 * refuse a trace or to apply back-pressure. The traced program must not be
 * able to observe the tracer, so the only channel for "this did not work" is
 * `LoomTraceConfig.onError`.
 *
 * Implementing one? The full contract in both directions is in `DESIGN.md`,
 * section 5.1. In short: loomtrace calls `write` exactly once per trace with a
 * complete `TraceNode`, hands over ownership of it, and catches anything you
 * throw; you tolerate overlapping calls, own your retries, and resolve
 * `flush()` only when the data is really delivered.
 */
export interface LoomDestination {
  /**
   * Optional label, used when loomtrace reports a failure through `onError`.
   *
   * Worth setting on a custom destination: "destination write failed" is a
   * much less useful message than naming the sink that failed.
   */
  readonly name?: string;

  /**
   * Hand over one finished trace.
   *
   * May be synchronous or asynchronous. loomtrace never awaits this at the
   * call site — `.run()` returns exactly what its callback returned and does
   * not become async because a destination is slow — so a returned promise is
   * tracked and awaited by `LoomTrace.flush()` instead.
   */
  write(trace: TraceNode): void | Promise<void>;

  /**
   * Resolve once everything handed over so far is durable: written to disk,
   * acknowledged by the server, whatever "delivered" means for this sink.
   *
   * Omit it if `write` already finishes the job.
   */
  flush?(): Promise<void>;

  /**
   * Called on every span this trace opens or closes, including the root —
   * not just once at the end.
   *
   * `write` stays the one required, final call: a destination that ignores
   * `onSpanUpdate` sees exactly what it saw before this existed. Implement it
   * when a whole trace arriving only at the end is not good enough — a
   * process that might be killed mid-run, or a live view that wants to redraw
   * as spans complete.
   *
   * `trace` is the same object `write` will eventually receive, at whatever
   * point it has reached so far: still growing, `status: "unset"`, no
   * `endTime` yet. It keeps growing after this call returns, so a destination
   * that needs a stable snapshot has to read what it needs before returning —
   * synchronously, or via something like `JSON.stringify` called immediately —
   * the same discipline `write` itself already requires.
   */
  onSpanUpdate?(span: SpanNode, trace: TraceNode): void | Promise<void>;

  /**
   * Flush, then release resources — file handles, sockets, timers.
   *
   * Must be idempotent: `LoomTrace.shutdown()` may be called from both an
   * explicit teardown and a process-exit hook.
   */
  shutdown?(): Promise<void>;
}

/**
 * Where a `LoomTrace` instance sends its traces.
 *
 * The string forms are shorthands the embedding framework can pass straight
 * through from its own user-facing flag, e.g. `trace: "local" | "silent"`. The
 * object form is the escape hatch.
 *
 * This union is what lets `"cloud"` arrive later without anything changing
 * shape. A configured object form — `{ type: "cloud", apiKey, project }` — can
 * join it too: `LoomDestination` structurally requires a `write` method, so a
 * plain config object is never mistaken for one.
 */
export type DestinationSpec = "silent" | "local" | LoomDestination;

/*
 * The normative contract — what loomtrace guarantees a destination and what a
 * destination owes in return — lives in `DESIGN.md`, section 5.1, so that
 * there is one copy of it to keep true. Section 5.2 covers why the contract is
 * whole-trace rather than a stream of spans, and why making it a stream later
 * is additive.
 */
