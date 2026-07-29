/**
 * `LoomTraceSpanProcessor`.
 *
 * Registered on a `TracerProvider` like any other `SpanProcessor`, it has no
 * idea what produced the spans it sees; Vercel AI SDK is simply the
 * motivating producer, not a dependency of this file. What it does own:
 * buffering a trace's spans as they end, in whatever order that happens, and
 * handing the whole thing to a `LoomDestination` once the trace's root span
 * ends — the same "whole traces, not a stream" contract `LoomTrace` itself
 * honors.
 *
 * Same non-negotiable as the rest of loomtrace: this runs inside somebody
 * else's OTel pipeline, on every span their application produces, so nothing
 * in here may throw into it. Every method is a try/catch around real work,
 * reporting through `onError` exactly like `LoomTrace` does.
 */

import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SCHEMA_VERSION, type LoomDestination, type SpanNode, type TraceNode } from "@loomtrace/core";

import { toPendingSpanNode, toSpanNode } from "./span-node.js";

export interface LoomTraceSpanProcessorOptions {
  /**
   * Where finished traces go. Omitted means "record nothing" — the same free
   * no-destination path `LoomTrace` takes for `"silent"`: with nothing to
   * write to, spans are never even buffered.
   *
   * No `"silent" | "local"` shorthand here, unlike `LoomTraceConfig` — this
   * class is wired up by whoever is already constructing a `TracerProvider`
   * by hand, not forwarding an end-user flag, so passing a concrete
   * `LoomDestination` (`new LocalDestination()` from `@loomtrace/core`, or
   * any other one) is the natural, and only, way in.
   */
  destination?: LoomDestination;
  /**
   * Reports this processor's own failures — a destination that rejects, a
   * span that fails to convert. Never thrown into the traced application;
   * defaults to a single `console.warn` per instance, like `LoomTrace`.
   */
  onError?: (error: Error) => void;
}

/** One trace's spans, keyed by span id, as they arrive in any order. */
interface TraceBuffer {
  spans: Map<string, SpanNode>;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function defaultOnError(): (error: Error) => void {
  let warned = false;
  return (error) => {
    if (warned) return;
    warned = true;
    console.warn(
      `[loomtrace/otel] ${error.message} — spans are being dropped; further warnings are suppressed, pass onError to handle them.`,
    );
  };
}

/** A `write()`/`flush()`/`shutdown()` return value that finishes later. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

export class LoomTraceSpanProcessor implements SpanProcessor {
  readonly #destination: LoomDestination | null;
  readonly #onError: (error: Error) => void;
  readonly #traces = new Map<string, TraceBuffer>();
  readonly #pendingWrites = new Set<Promise<void>>();
  #shutdown = false;

  constructor(options: LoomTraceSpanProcessorOptions = {}) {
    this.#onError = options.onError ?? defaultOnError();
    this.#destination = this.#resolveDestination(options.destination);
  }

  #resolveDestination(destination: LoomDestination | undefined): LoomDestination | null {
    if (destination === undefined) return null;
    if (typeof destination.write !== "function") {
      this.#onError(
        new Error("destination has no write() method; spans are being discarded"),
      );
      return null;
    }
    return destination;
  }

  #getOrCreateBuffer(traceId: string): TraceBuffer {
    let buffer = this.#traces.get(traceId);
    if (buffer === undefined) {
      buffer = { spans: new Map() };
      this.#traces.set(traceId, buffer);
    }
    return buffer;
  }

  onStart(span: Span, _parentContext: Context): void {
    if (this.#destination === null || this.#shutdown) return;
    try {
      const buffer = this.#getOrCreateBuffer(span.spanContext().traceId);
      const spanId = span.spanContext().spanId;
      if (!buffer.spans.has(spanId)) {
        buffer.spans.set(spanId, toPendingSpanNode(span));
      }
    } catch (error) {
      this.#onError(toError(error));
    }
  }

  onEnd(span: ReadableSpan): void {
    if (this.#destination === null || this.#shutdown) return;
    try {
      const traceId = span.spanContext().traceId;
      const buffer = this.#getOrCreateBuffer(traceId);
      const node = toSpanNode(span);
      buffer.spans.set(node.id, node);

      // A trace is delivered when its root span ends — the span this
      // processor never saw a parent for. That includes the common case
      // (a genuine root, `parentId === null`) and, deliberately, nothing
      // else: a span whose parent lives in another process (a remote-parented
      // server span) looks the same as a genuine root from here, and this
      // processor has no way to learn that its "trace" is only ever a
      // fragment of a larger, distributed one. Reassembling a trace across
      // processes is out of scope (this bridge exists for single-process
      // agent execution, per the plan's own framing) — a trace like that
      // simply never seals, and its buffer is dropped, not delivered, on
      // `shutdown()`.
      if (node.parentId === null) {
        this.#traces.delete(traceId);
        this.#deliver(traceId, node, buffer);
      }
    } catch (error) {
      this.#onError(toError(error));
    }
  }

  #deliver(traceId: string, root: SpanNode, buffer: TraceBuffer): void {
    if (this.#destination === null) return;

    const trace: TraceNode = {
      schemaVersion: SCHEMA_VERSION,
      id: traceId,
      name: root.name,
      startTime: root.startTime,
      status: root.status,
      spans: [...buffer.spans.values()],
    };
    if (root.endTime !== undefined) trace.endTime = root.endTime;
    if (root.durationMs !== undefined) trace.durationMs = root.durationMs;
    if (root.cancelled !== undefined) trace.cancelled = root.cancelled;

    try {
      const result = this.#destination.write(trace);
      if (isThenable(result)) {
        const tracked: Promise<void> = Promise.resolve(result).then(
          () => undefined,
          (error: unknown) => {
            this.#onError(toError(error));
          },
        );
        this.#pendingWrites.add(tracked);
        void tracked.finally(() => this.#pendingWrites.delete(tracked));
      }
    } catch (error) {
      this.#onError(toError(error));
    }
  }

  async #drainWrites(): Promise<void> {
    // A loop, not one snapshot: a destination that traces its own write() —
    // and so calls back into this same processor — can add new entries to
    // `#pendingWrites` while this is draining, the same case `LoomTrace.flush()`
    // already has to handle.
    while (this.#pendingWrites.size > 0) {
      const batch = [...this.#pendingWrites];
      await Promise.all(batch);
      for (const write of batch) this.#pendingWrites.delete(write);
    }
  }

  async forceFlush(): Promise<void> {
    await this.#drainWrites();
    if (this.#destination?.flush === undefined) return;
    try {
      await this.#destination.flush();
    } catch (error) {
      this.#onError(toError(error));
    }
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.forceFlush();
    // Whatever never sealed (no locally-visible root) is dropped here, not
    // delivered — see the comment in `onEnd()`. Same class of loss core
    // already accepts for a killed process: a trace this processor cannot
    // complete is not a new failure mode, just this one a level up.
    this.#traces.clear();
    if (this.#destination?.shutdown === undefined) return;
    try {
      await this.#destination.shutdown();
    } catch (error) {
      this.#onError(toError(error));
    }
  }
}
