/**
 * Public API surface of `@loomtrace/core`.
 *
 * Types only. The implementation lands in item 3.1; this file is the contract
 * it has to satisfy, and it is deliberately written first so the shape can be
 * argued about while changing it is still free.
 */

import type { DestinationSpec } from "./destinations/destination.js";
import type { JsonValue, SpanType } from "./schema.js";

/**
 * Configuration for a `LoomTrace` instance.
 *
 * Every field is optional: `new LoomTrace()` must be valid and must do nothing
 * observable. loomtrace is a dependency of somebody else's framework, and a
 * misconfigured tracer is never a good enough reason to break their users.
 */
export interface LoomTraceConfig {
  /**
   * Where to send finished traces. Defaults to `"silent"`.
   *
   * Silent by default because the framework author decides when tracing is on,
   * and writing files to a user's working directory without being asked is not
   * a decision a transitive dependency gets to make.
   */
  destination?: DestinationSpec;
  /**
   * Master switch. When `false`, `.run()` and `.step()` still invoke their
   * callbacks and return their values, but nothing is recorded or written.
   *
   * Exists so the embedding framework can forward a user flag directly, rather
   * than conditionally constructing a tracer and branching every call site.
   */
  enabled?: boolean;
  /** Attached to every trace this instance produces: environment, release, service name. */
  metadata?: Record<string, JsonValue>;
  /**
   * Called when loomtrace itself fails — a destination write rejects, a value
   * will not serialize.
   *
   * These failures are swallowed rather than thrown: an error in the tracer
   * must not surface as an error in the traced program. This hook is the only
   * way to find out that it happened, so it defaults to a single warning on
   * `console`, not to silence.
   */
  onError?: (error: Error) => void;
}

/**
 * The part of an `AbortSignal` loomtrace reads — and the whole of it.
 *
 * Structural rather than the `AbortSignal` global so that a polyfill, a signal
 * from another realm, or any object carrying an `aborted` flag is accepted, and
 * so that the type itself states how little is used. A real `AbortSignal`
 * satisfies it.
 */
export interface AbortSignalLike {
  /** Whether the signal has fired. */
  readonly aborted: boolean;
}

/** Per-call options shared by `.run()` and `.step()`. */
export interface SpanOptions {
  /** What kind of work this is. Defaults to `"run"` for runs, `"step"` for steps. */
  type?: SpanType;
  /**
   * What the work was called with.
   *
   * Explicit, because a callback-shaped API cannot see the arguments of the
   * function it wraps — unlike LangSmith's `traceable(fn)` or Braintrust's
   * `wrapTraced(fn)`, which capture `Parameters<F>` automatically. That is a
   * deliberate trade: the framework embedding loomtrace knows which of its
   * arguments are worth recording, and `arguments` does not.
   */
  input?: JsonValue;
  /** Annotations for this span: model, attempt number, cost, cache hit. */
  metadata?: Record<string, JsonValue>;
  /**
   * The signal governing this work, if it has one.
   *
   * Read once, and only if the callback failed: a signal that had fired by then
   * marks the span `cancelled` (see `SpanNode.cancelled`). Passing it is
   * optional — an abort that arrives as a recognizable `AbortError` or
   * `TimeoutError` is detected without it — and it is what makes detection
   * reliable for `controller.abort(reason)` with a reason of the caller's own,
   * which surfaces as an ordinary error with nothing abort-shaped about it.
   *
   * loomtrace never subscribes to the signal, never aborts anything, and never
   * closes a span because one fired: a span's lifetime is its callback's.
   */
  signal?: AbortSignalLike;
}

/** Options for `.run()`. */
export interface RunOptions extends SpanOptions {
  /**
   * Run-level annotations, merged over `LoomTraceConfig.metadata`.
   *
   * A nested run has no trace of its own, so these are folded into its span's
   * `metadata` instead — `metadata` wins where the two collide.
   */
  traceMetadata?: Record<string, JsonValue>;
}

/** Options for `.step()`. */
export type StepOptions = SpanOptions;

/**
 * A handle to the span currently being recorded, passed to every `.run()` and
 * `.step()` callback.
 *
 * There is no `end()`: the span's lifetime is exactly the callback's, and
 * loomtrace closes it. Manually-managed spans — the kind needed for a
 * streaming response that finishes after its function returns — are out of
 * scope for now, and adding them later is additive.
 */
export interface LoomSpan {
  /** This span's id. 16 lowercase hex characters. */
  readonly id: string;
  /** The id of the trace this span belongs to. 32 lowercase hex characters. */
  readonly traceId: string;
  /** The enclosing span's id, or `null` if this is the trace's root span. */
  readonly parentId: string | null;

  /** Record what this span was called with, if it was not passed up front. */
  setInput(input: JsonValue): void;
  /**
   * Record the span's result explicitly.
   *
   * By default the callback's resolved return value is used. Call this when
   * that value is not the interesting part — a `Response` object, a stream, a
   * handle — or is too large to store whole.
   */
  setOutput(output: JsonValue): void;
  /** Merge annotations into this span's metadata. Later keys win. */
  setMetadata(metadata: Record<string, JsonValue>): void;

  /**
   * Start a child span of *this* span, regardless of what is ambiently
   * current.
   *
   * The explicit counterpart to `LoomTrace.step()`. Use it when the parent is
   * not the ambient span — across a callback boundary, inside a queue worker,
   * anywhere `AsyncLocalStorage` cannot follow.
   */
  step<T>(name: string, fn: (span: LoomSpan) => T): T;
  step<T>(name: string, options: StepOptions, fn: (span: LoomSpan) => T): T;
}

/**
 * The tracer.
 *
 * `class LoomTrace implements LoomTraceApi` in item 3.1. Kept as a separate
 * interface so tests and framework authors can substitute a double without
 * depending on the implementation.
 */
export interface LoomTraceApi {
  /**
   * Record one complete execution: opens a trace, runs `fn` inside its root
   * span, closes the trace and hands it to the destination.
   *
   * Returns exactly what `fn` returns — `T` is inferred as `Promise<R>` for an
   * async callback and as `R` for a sync one, so wrapping a call in `.run()`
   * never changes its type or its synchronicity.
   *
   * The span's status follows the callback: resolved is `"ok"`, thrown or
   * rejected is `"error"` with the error recorded. Exceptions are always
   * re-thrown — loomtrace observes control flow, it does not participate in
   * it.
   *
   * A `.run()` called inside another run of the same tracer does not start a
   * second trace: it becomes a child span of the enclosing one, keeping
   * `type: "run"` so a reader can see where one execution called another. Its
   * `traceMetadata` is folded into that span's `metadata`, since there is no
   * trace of its own to annotate.
   */
  run<T>(name: string, fn: (span: LoomSpan) => T): T;
  run<T>(name: string, options: RunOptions, fn: (span: LoomSpan) => T): T;

  /**
   * Record a step inside the ambient run, as a child of whatever span is
   * currently active.
   *
   * Called outside any `.run()`, this invokes `fn` and returns its value
   * without recording anything, reporting once through `onError`. It does not
   * throw and does not start an implicit run: a library that calls `.step()`
   * on a code path its user never wrapped in `.run()` is a missing trace, not
   * a broken program.
   */
  step<T>(name: string, fn: (span: LoomSpan) => T): T;
  step<T>(name: string, options: StepOptions, fn: (span: LoomSpan) => T): T;

  /**
   * Resolves once every trace finished so far has reached the destination:
   * awaits the writes still in flight, then the destination's own
   * `flush()`, if it has one.
   *
   * loomtrace never calls this itself, on exit or otherwise — see
   * `DESIGN.md`, section 5.4. The embedding framework calls it at its own
   * natural teardown point; a process killed before that runs loses whatever
   * had not yet reached the destination.
   */
  flush(): Promise<void>;

  /**
   * Flush, then release resources by calling the destination's `shutdown()`.
   * The instance is unusable afterwards.
   */
  shutdown(): Promise<void>;
}
