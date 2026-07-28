/**
 * The tracer.
 *
 * Items 3.1 and 3.2: `.run()` opens a trace around a callback, sync or async;
 * `.step()` opens a child span inside whatever run is ambiently active, which
 * is what the `AsyncLocalStorage` in this file is for.
 *
 * The shape of everything below is fixed by `api.ts` and argued for in
 * `DESIGN.md`. Two of its rules drive most of what looks unusual here:
 * `.run()` returns exactly what its callback returned, with the same type and
 * the same synchronicity, and no failure of ours is allowed to reach the traced
 * program.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AbortSignalLike,
  LoomSpan,
  LoomTraceApi,
  LoomTraceConfig,
  RunOptions,
  SpanOptions,
  StepOptions,
} from "./api.js";
import { durationMs, formatTimestamp, now, type EpochNanos } from "./clock.js";
import type { DestinationSpec, LoomDestination } from "./destinations/destination.js";
import { describeCause, isCancellation, toSpanError } from "./errors.js";
import { LocalDestination } from "./destinations/local-destination.js";
import {
  createSpanId,
  createTraceId,
  INVALID_SPAN_ID,
  INVALID_TRACE_ID,
} from "./ids.js";
import type { JsonValue, SpanNode, SpanType, TraceNode } from "./schema.js";
import { SCHEMA_VERSION } from "./version.js";

type SpanCallback<T> = (span: LoomSpan) => T;

/**
 * A trace being recorded, and whether it has already been handed over.
 *
 * `sealed` exists because a span can outlive its run: a `.step()` that is never
 * awaited is still open when the root closes, and the trace goes to the
 * destination without it. Once that has happened the destination owns the
 * object (DESIGN 5.1), so the late span must not write into it — it stays in
 * the delivered trace as `status: "unset"`, which is exactly what that status
 * is for.
 */
interface TraceState {
  node: TraceNode;
  sealed: boolean;
}

/** What `.step()` needs to find: the span to hang a child off, and its trace. */
interface Frame {
  trace: TraceState;
  span: RecordingSpan;
}

/**
 * How a span handle opens a child of itself.
 *
 * Injected by the tracer that created the span rather than reached for through
 * a back-reference, so that `span.step()` cannot end up in a different tracer's
 * bookkeeping than the span it was called on.
 */
type StartChild = <T>(
  parent: RecordingSpan,
  name: string,
  options: StepOptions | undefined,
  fn: SpanCallback<T>,
) => T;

/**
 * Split the two call shapes — `(name, fn)` and `(name, options, fn)` — into
 * their parts.
 *
 * `typeof x === "function"` is the discriminant rather than an `options` field
 * check, because a callback is the only argument in either position that can be
 * a function.
 */
function normalizeArgs<O, T>(
  optionsOrFn: O | SpanCallback<T>,
  maybeFn: SpanCallback<T> | undefined,
): { options: O | undefined; fn: SpanCallback<T> } {
  if (typeof optionsOrFn === "function") {
    return { options: undefined, fn: optionsOrFn as SpanCallback<T> };
  }
  return { options: optionsOrFn, fn: maybeFn as SpanCallback<T> };
}

/**
 * Turn `.run()` options into `.step()` options, for a run that turned out to be
 * nested inside another one.
 *
 * A nested run is a span, not a trace, so `traceMetadata` has no trace of its
 * own left to annotate. It is folded into the span's metadata rather than
 * dropped, and rather than merged into the enclosing trace — a sub-agent
 * declaring `{ session: "…" }` must not overwrite its caller's. Keys the caller
 * also passed in `metadata` win, since those were meant for this span all
 * along.
 */
function demoteRunOptions(
  options: RunOptions | undefined,
): StepOptions | undefined {
  if (options?.traceMetadata === undefined) return options;
  const { traceMetadata, ...rest } = options;
  return { ...rest, metadata: { ...traceMetadata, ...rest.metadata } };
}

/**
 * Whether the signal governing a span had already fired.
 *
 * Read defensively and only once, at close time: the object comes from the
 * caller, `aborted` may be a getter on a proxy, and a tracer that throws while
 * recording a failure fails in the worst possible place. A signal it cannot
 * read is a signal that says nothing.
 */
function wasAborted(signal: AbortSignalLike | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    return false;
  }
}

/**
 * Whether a callback's return value should be waited on before closing the
 * span.
 *
 * Deliberately a thenable check and not `instanceof Promise`: userland promise
 * implementations, and the async functions of a bundler's downlevelled output,
 * are not native promises but do finish later, and closing their span at the
 * moment they were called would record a duration of nothing.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Turn a `DestinationSpec` into something with a `write` method, or into
 * `null`, which means "record nothing at all".
 *
 * Resolution is deliberately total: an unusable destination degrades to `null`
 * and a report through `onError`, because a tracer that throws at construction
 * would take down a program that only wanted a log.
 */
function resolveDestination(
  spec: DestinationSpec | undefined,
  onError: (error: Error) => void,
): LoomDestination | null {
  if (spec === undefined || spec === "silent") return null;

  // The default directory, resolved against `process.cwd()` at construction
  // time. A caller who wants a different one passes a `LocalDestination`
  // instance directly instead of the shorthand.
  if (spec === "local") return new LocalDestination();

  if (typeof spec.write !== "function") {
    onError(
      new Error("destination has no write() method; traces are being discarded"),
    );
    return null;
  }

  return spec;
}

/**
 * The default `onError`: warn on `console`, once per instance.
 *
 * Once, because the failure that matters here is systemic — a destination that
 * cannot write will fail on every trace — and a tracer nobody asked for is not
 * entitled to fill somebody's log with the same line a thousand times. The
 * warning names `onError` so the way to see the rest is in the message.
 */
function defaultOnError(): (error: Error) => void {
  let warned = false;
  return (error) => {
    if (warned) return;
    warned = true;
    console.warn(
      `[loomtrace] ${error.message} — tracing continues; further warnings are suppressed, pass onError to handle them.`,
    );
  };
}

/**
 * A span that is being recorded.
 *
 * It is a thin handle over the `SpanNode` already sitting in the trace's
 * `spans` array: mutating the node in place means a trace is complete the
 * moment its last span closes, with nothing to collect afterwards.
 */
class RecordingSpan implements LoomSpan {
  readonly id: string;
  readonly traceId: string;
  readonly parentId: string | null;

  /** @internal The record this handle writes to. */
  readonly node: SpanNode;
  /** @internal The trace this span belongs to. */
  readonly trace: TraceState;
  /** @internal When the span started, for its duration. */
  readonly startedAt: EpochNanos;
  /** @internal The signal governing this work, consulted if the callback fails. */
  readonly signal: AbortSignalLike | undefined;
  /** @internal Whether `setOutput` was called, which suppresses the implicit one. */
  outputSet = false;
  /** @internal Guards against a span being closed twice. */
  closed = false;

  readonly #startChild: StartChild;

  constructor(
    node: SpanNode,
    trace: TraceState,
    startedAt: EpochNanos,
    signal: AbortSignalLike | undefined,
    startChild: StartChild,
  ) {
    this.id = node.id;
    this.parentId = node.parentId;
    this.traceId = trace.node.id;
    this.node = node;
    this.trace = trace;
    this.startedAt = startedAt;
    this.signal = signal;
    this.#startChild = startChild;
  }

  setInput(input: JsonValue): void {
    this.node.input = input;
  }

  setOutput(output: JsonValue): void {
    this.node.output = output;
    this.outputSet = true;
  }

  setMetadata(metadata: Record<string, JsonValue>): void {
    this.node.metadata = { ...this.node.metadata, ...metadata };
  }

  step<T>(name: string, fn: SpanCallback<T>): T;
  step<T>(name: string, options: StepOptions, fn: SpanCallback<T>): T;
  step<T>(
    name: string,
    optionsOrFn: StepOptions | SpanCallback<T>,
    maybeFn?: SpanCallback<T>,
  ): T {
    const { options, fn } = normalizeArgs(optionsOrFn, maybeFn);
    return this.#startChild(this, name, options, fn);
  }
}

/**
 * The handle passed to callbacks that are not being recorded — tracing
 * disabled, no destination, or a `.step()` with no run around it.
 *
 * A shared frozen object rather than one per call: it holds no state, and the
 * disabled path should allocate nothing. Its ids are OpenTelemetry's invalid
 * ids, so code that logs `span.traceId` prints something recognizably absent
 * instead of a plausible id that leads nowhere.
 */
const INERT_SPAN: LoomSpan = Object.freeze({
  id: INVALID_SPAN_ID,
  traceId: INVALID_TRACE_ID,
  parentId: null,
  setInput() {},
  setOutput() {},
  setMetadata() {},
  step<T>(
    _name: string,
    optionsOrFn: StepOptions | SpanCallback<T>,
    maybeFn?: SpanCallback<T>,
  ): T {
    return normalizeArgs(optionsOrFn, maybeFn).fn(INERT_SPAN);
  },
});

/**
 * Records executions and hands finished traces to a destination.
 *
 * ```ts
 * const tracer = new LoomTrace({ destination: myDestination });
 *
 * const answer = await tracer.run("answer-question", { input: { question } }, async () => {
 *   const docs = await tracer.step("retrieve", () => retrieve(question));
 *   return generate(docs);
 * });
 * ```
 */
export class LoomTrace implements LoomTraceApi {
  readonly #destination: LoomDestination | null;
  readonly #metadata: Record<string, JsonValue> | undefined;
  readonly #onError: (error: Error) => void;

  /**
   * The span `.step()` attaches to, followed across `await`s and callbacks.
   *
   * One storage per tracer instance, not one per module. A module-level store
   * would be a global by another name: two frameworks that each embed
   * loomtrace would see each other's runs, and `.step()` on one tracer could
   * attach to a run opened by the other. It also would not survive what
   * actually happens in a dependency tree — two copies of this package at
   * different versions, each with its own module scope.
   */
  readonly #context = new AsyncLocalStorage<Frame>();

  /**
   * Writes handed to the destination that have not resolved yet.
   *
   * Every entry is a promise that cannot reject — failures are converted to an
   * `onError` report when it is added — so `flush()` can await the set without
   * a second layer of error handling, and an unawaited write can never surface
   * as an unhandled rejection.
   */
  readonly #inFlight = new Set<Promise<void>>();

  #shutDown = false;

  /** Handed to every span so that `span.step()` reaches back into this instance. */
  readonly #startChild: StartChild = (parent, name, options, fn) =>
    this.#openChild(parent, name, options, fn);

  constructor(config: LoomTraceConfig = {}) {
    this.#onError = this.#wrapOnError(config.onError);
    this.#metadata = config.metadata;
    this.#destination =
      config.enabled === false
        ? null
        : resolveDestination(config.destination, this.#onError);
  }

  run<T>(name: string, fn: SpanCallback<T>): T;
  run<T>(name: string, options: RunOptions, fn: SpanCallback<T>): T;
  run<T>(
    name: string,
    optionsOrFn: RunOptions | SpanCallback<T>,
    maybeFn?: SpanCallback<T>,
  ): T {
    const { options, fn } = normalizeArgs(optionsOrFn, maybeFn);

    if (this.#destination === null) return fn(INERT_SPAN);

    // A run inside a run is one execution calling another — an agent invoking a
    // sub-agent — and it belongs in the caller's trace, as a child span that
    // keeps `type: "run"` to mark where the boundary was. Item 3.5, DESIGN 4.10.
    //
    // The ambient frame is this instance's own, since the storage is per
    // tracer: another tracer's run is not visible here and does not nest.
    const frame = this.#context.getStore();
    if (frame !== undefined && !frame.trace.sealed) {
      // No `#shutDown` check on this path, for the same reason `.step()` has
      // none: shutdown stops new traces, and this adds to one already open.
      return this.#openChild(
        frame.span,
        name,
        demoteRunOptions(options),
        fn,
        "run",
        "starting a nested run",
      );
    }

    if (this.#shutDown) return fn(INERT_SPAN);

    let root: RecordingSpan;
    try {
      root = this.#openRun(name, options);
    } catch (error) {
      // Opening a trace is our bookkeeping, and a failure in it is our problem
      // — the caller still gets their callback run, untraced.
      this.#reportInternal(error, "starting a run");
      return fn(INERT_SPAN);
    }

    return this.#execute(root, fn);
  }

  step<T>(name: string, fn: SpanCallback<T>): T;
  step<T>(name: string, options: StepOptions, fn: SpanCallback<T>): T;
  step<T>(
    name: string,
    optionsOrFn: StepOptions | SpanCallback<T>,
    maybeFn?: SpanCallback<T>,
  ): T {
    const { options, fn } = normalizeArgs(optionsOrFn, maybeFn);

    // No `#shutDown` check, unlike `.run()`: shutdown stops new traces from
    // starting, and a step only ever adds to a trace that is already open. A
    // run that loses its children halfway through is worse than one that
    // finishes after the lights went out.
    if (this.#destination === null) return fn(INERT_SPAN);

    const frame = this.#context.getStore();
    if (frame === undefined) {
      // Documented behaviour, not an error in the traced program: a library
      // that steps on a path its user never wrapped in `.run()` has a missing
      // trace, not a broken call. Reported, because the alternative is a step
      // that silently never shows up in any trace.
      this.#onError(
        new Error(`step(${JSON.stringify(name)}) was called outside of a run; it was not recorded`),
      );
      return fn(INERT_SPAN);
    }

    return this.#openChild(frame.span, name, options, fn);
  }

  async flush(): Promise<void> {
    // A `write` that resolves may hand over another trace, so drain until the
    // set is genuinely empty rather than snapshotting it once.
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight]);
    }

    if (this.#destination?.flush) {
      try {
        await this.#destination.flush();
      } catch (error) {
        this.#report(error, "flush");
      }
    }
  }

  async shutdown(): Promise<void> {
    // Set first: the contract says nothing is written after `shutdown()`
    // resolves, and a `.run()` starting while the flush is in flight would
    // otherwise slip a trace in behind it.
    const alreadyDown = this.#shutDown;
    this.#shutDown = true;

    await this.flush();

    // Idempotent, since this may be called from both an explicit teardown and
    // a process-exit hook — item 4.4.
    if (alreadyDown) return;

    if (this.#destination?.shutdown) {
      try {
        await this.#destination.shutdown();
      } catch (error) {
        this.#report(error, "shutdown");
      }
    }
  }

  /** Open a trace and its root span. */
  #openRun(name: string, options: RunOptions | undefined): RecordingSpan {
    const startedAt = now();
    const traceMetadata = { ...this.#metadata, ...options?.traceMetadata };
    const trace: TraceState = {
      sealed: false,
      node: {
        schemaVersion: SCHEMA_VERSION,
        id: createTraceId(),
        name,
        startTime: formatTimestamp(startedAt),
        status: "unset",
        spans: [],
        ...(Object.keys(traceMetadata).length === 0
          ? {}
          : { metadata: traceMetadata }),
      },
    };

    return this.#openSpan(trace, null, name, options, "run", startedAt);
  }

  /**
   * Open a child of `parent`, on `parent`'s trace rather than on the ambient
   * one.
   *
   * `defaultType` and `doing` differ only for a nested `.run()`, which comes
   * through here as a child span but is neither typed nor reported as a step.
   */
  #openChild<T>(
    parent: RecordingSpan,
    name: string,
    options: StepOptions | undefined,
    fn: SpanCallback<T>,
    defaultType: SpanType = "step",
    doing = "starting a step",
  ): T {
    // The run this span belongs to is over and its trace has been handed to the
    // destination. Recording into it now would mutate an object we no longer
    // own, so the callback runs untraced instead.
    if (parent.trace.sealed) return fn(INERT_SPAN);

    let span: RecordingSpan;
    try {
      span = this.#openSpan(parent.trace, parent.id, name, options, defaultType);
    } catch (error) {
      this.#reportInternal(error, doing);
      return fn(INERT_SPAN);
    }

    return this.#execute(span, fn);
  }

  /** Add a span to a trace, open, and hand back the handle for it. */
  #openSpan(
    trace: TraceState,
    parentId: string | null,
    name: string,
    options: SpanOptions | undefined,
    defaultType: SpanType,
    startedAt: EpochNanos = now(),
  ): RecordingSpan {
    const node: SpanNode = {
      id: createSpanId(),
      parentId,
      name,
      type: options?.type ?? defaultType,
      startTime: formatTimestamp(startedAt),
      status: "unset",
      ...(options?.input === undefined ? {} : { input: options.input }),
      ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
    };

    // Appended while it is still open, so a span that never closes is still in
    // the trace — as `status: "unset"`, which is more informative than a gap.
    trace.node.spans.push(node);

    return new RecordingSpan(
      node,
      trace,
      startedAt,
      options?.signal,
      this.#startChild,
    );
  }

  /**
   * Run a callback as the given span: ambient for its duration, closed when it
   * settles, transparent to both its value and its exceptions.
   */
  #execute<T>(span: RecordingSpan, fn: SpanCallback<T>): T {
    const frame: Frame = { trace: span.trace, span };

    let result: T;
    try {
      result = this.#context.run(frame, fn, span);
    } catch (error) {
      // Synchronous throw: the span is over, and the exception belongs to the
      // caller unchanged. Item 3.3 covers what is recorded; this closes it.
      this.#close(span, "error", error);
      throw error;
    }

    if (isThenable(result)) {
      // The callback is still running. Closing here would record the time it
      // took to *start*, so the span ends when the promise settles — watched
      // from the side, with the caller's own promise handed straight back.
      //
      // Watching rather than chaining is what keeps the tracer out of the
      // program's control flow, and it matters most in the concurrent code this
      // is for. A derived `result.then(...)` is a second place the same
      // rejection has to be handled, and only one of the two is being watched:
      // a caller who keeps the original — `const p = send();
      // tracer.step("send", () => p); await p;`, a step opened purely to time
      // work awaited elsewhere — handles theirs while ours rejects with nobody
      // attached, and an unhandled rejection ends a Node process by default. It
      // also keeps `.run()` returning literally what its callback returned, a
      // non-native thenable included. DESIGN 4.9.
      //
      // Ordering survives it: this handler is attached before `.step()` returns
      // and so precedes anything the caller attaches afterwards, which is what
      // keeps a branch of a `Promise.all` closing inside its parent's lifetime.
      //
      // What it costs is that observing a rejection marks it handled, so a step
      // nobody awaited is recorded on its span rather than reaching
      // `unhandledRejection` — a fair trade only while there is still a span to
      // record it on, which is what `#reportLost` is for.
      //
      // Via `Promise.resolve` so a thenable's `then` returning something odd
      // stays contained here; a native promise passes through unchanged, and
      // the extra `then` call a non-native one sees is one it already tolerates
      // from `await` and `Promise.all`.
      void Promise.resolve(result).then(
        (value) => this.#close(span, "ok", undefined, value),
        (error: unknown) => {
          if (!this.#close(span, "error", error)) this.#reportLost(span, error);
        },
      );
      return result;
    }

    this.#close(span, "ok", undefined, result);
    return result;
  }

  /**
   * Close a span, and if it is a root span, finish the trace and hand it over.
   * Returns whether the outcome was written down anywhere.
   *
   * Wrapped, because every call site is either returning a value to the caller
   * or re-throwing their exception, and a failure of ours here would replace
   * one of those with a stack trace from inside a tracer. Recording a span is
   * never worth that.
   */
  #close(
    span: RecordingSpan,
    status: "ok" | "error",
    error?: unknown,
    output?: unknown,
  ): boolean {
    try {
      return this.#closeSpan(span, status, error, output);
    } catch (failure) {
      this.#reportInternal(failure, "closing a span");
      return false;
    }
  }

  /**
   * `output` is only consulted for a successful span, and only when the
   * callback did not call `setOutput` itself.
   */
  #closeSpan(
    span: RecordingSpan,
    status: "ok" | "error",
    error?: unknown,
    output?: unknown,
  ): boolean {
    if (span.closed) return false;
    span.closed = true;

    // Its trace is already at the destination — see `TraceState.sealed`.
    if (span.trace.sealed) return false;

    const endedAt = now();
    const endTime = formatTimestamp(endedAt);
    const elapsedMs = durationMs(span.startedAt, endedAt);
    const node = span.node;

    node.endTime = endTime;
    node.durationMs = elapsedMs;
    node.status = status;

    if (status === "error") {
      node.error = toSpanError(error);

      // Item 3.6, DESIGN 4.11. Two independent ways of learning the same thing,
      // because neither is sufficient alone: the thrown value carries the news
      // when the abort surfaces as an `AbortError`, and the signal carries it
      // when the caller aborted with a reason of their own, which arrives as an
      // ordinary error with nothing recognizable about it.
      //
      // Consulted only on failure. A signal that fires after the work already
      // succeeded — one signal shared by a whole request, aborted as it winds
      // down — has nothing to say about a span that finished before it.
      if (isCancellation(error) || wasAborted(span.signal)) {
        node.cancelled = true;
      }
    } else if (!span.outputSet && output !== undefined) {
      // Recorded as-is. Values that will not survive `JSON.stringify` are the
      // destination boundary's problem to handle defensively — see DESIGN 2.4.
      node.output = output as JsonValue;
    }

    if (span.parentId !== null) return true;

    const trace = span.trace.node;
    trace.endTime = endTime;
    trace.durationMs = elapsedMs;
    trace.status = status;
    if (node.cancelled === true) trace.cancelled = true;
    span.trace.sealed = true;

    this.#emit(trace);
    return true;
  }

  /** Hand a finished trace to the destination, absorbing anything it does about it. */
  #emit(trace: TraceNode): void {
    const destination = this.#destination;
    if (destination === null) return;

    let pending: void | Promise<void>;
    try {
      pending = destination.write(trace);
    } catch (error) {
      this.#report(error, "write");
      return;
    }

    if (!isThenable(pending)) return;

    // Tracked so `flush()` has something to await, and attached to immediately
    // so a slow write that fails long after `.run()` returned cannot become an
    // unhandled rejection in somebody else's process.
    const settled = Promise.resolve(pending).then(
      () => {
        this.#inFlight.delete(settled);
      },
      (error: unknown) => {
        this.#inFlight.delete(settled);
        this.#report(error, "write");
      },
    );
    this.#inFlight.add(settled);
  }

  /** Report a destination's failure through `onError`, naming the method that caused it. */
  #report(error: unknown, method: string): void {
    const name = this.#destination?.name ?? "destination";
    this.#onError(
      new Error(`${name}.${method}() failed: ${describeCause(error)}`, {
        cause: error,
      }),
    );
  }

  /**
   * Report a failure that reached no span and no trace.
   *
   * This is the one leak in watching a promise instead of chaining onto it.
   * Attaching a rejection handler marks the promise handled, so a step nobody
   * awaited no longer reaches `unhandledRejection`; that is a fair trade while
   * the error lands on its span, where it is easier to read than a stack on
   * stderr. It stops being fair when there is no span left to write to — a step
   * that outlived its run, whose trace was sealed and handed over before it
   * failed. Without this the failure would be silent, and silence is the one
   * outcome a tracer must never cause.
   *
   * Reported rather than re-thrown: re-throwing would land in a promise nobody
   * holds, which is a process-terminating rejection raised by the tracer, on
   * behalf of a caller who may well have handled the original themselves.
   */
  #reportLost(span: RecordingSpan, error: unknown): void {
    this.#onError(
      new Error(
        `${JSON.stringify(span.node.name)} failed after its run had already finished, so the error is not in any trace: ${describeCause(error)}`,
        { cause: error },
      ),
    );
  }

  /**
   * Report a failure of loomtrace's own bookkeeping.
   *
   * Distinguished from `#report` because the two mean different things to
   * whoever reads them: one is a sink that could not take a trace, the other is
   * a bug in here.
   */
  #reportInternal(error: unknown, doing: string): void {
    this.#onError(
      new Error(`internal failure while ${doing}: ${describeCause(error)}`, {
        cause: error,
      }),
    );
  }

  /**
   * Wrap the configured `onError` so that it, too, cannot throw into the traced
   * program — it is the handler for our failures, and it is allowed to be one.
   */
  #wrapOnError(onError: LoomTraceConfig["onError"]): (error: Error) => void {
    const handler = onError ?? defaultOnError();
    return (error) => {
      try {
        handler(error);
      } catch {
        // Nothing left to report it to.
      }
    };
  }
}
