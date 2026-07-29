import { context as otelContext, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LoomDestination, TraceNode } from "@loomtrace/core";
import { describe, expect, it, vi } from "vitest";

import { LoomTraceSpanProcessor, type LoomTraceSpanProcessorOptions } from "./span-processor.js";

/**
 * A destination that just remembers what it was handed — no disk, no
 * network, so tests exercise the processor's buffering and lifecycle logic
 * against a real `NodeTracerProvider`, not a hand-rolled span.
 */
function recordingDestination(): { destination: LoomDestination; traces: TraceNode[] } {
  const traces: TraceNode[] = [];
  return {
    traces,
    destination: {
      write(trace) {
        traces.push(trace);
      },
    },
  };
}

/** Provider + processor pair, torn down at the end of each test that needs one. */
function setup(destination?: LoomDestination, onError?: (error: Error) => void) {
  const options: LoomTraceSpanProcessorOptions = {};
  if (destination !== undefined) options.destination = destination;
  if (onError !== undefined) options.onError = onError;
  const processor = new LoomTraceSpanProcessor(options);
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("test");
  return { processor, provider, tracer };
}

describe("LoomTraceSpanProcessor — basic delivery", () => {
  it("delivers a single-span trace once its root span ends", () => {
    const { destination, traces } = recordingDestination();
    const { tracer } = setup(destination);

    const root = tracer.startSpan("answer-question");
    root.setStatus({ code: SpanStatusCode.OK });
    root.end();

    expect(traces).toHaveLength(1);
    const trace = traces[0]!;
    expect(trace.id).toBe(root.spanContext().traceId);
    expect(trace.name).toBe("answer-question");
    expect(trace.status).toBe("ok");
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]).toMatchObject({
      id: root.spanContext().spanId,
      parentId: null,
      type: "run",
    });
  });

  it("links a child span to its parent and delivers both as one trace", () => {
    const { destination, traces } = recordingDestination();
    const { tracer } = setup(destination);

    const root = tracer.startSpan("run");
    const parentCtx = trace.setSpan(otelContext.active(), root);
    const child = tracer.startSpan("step", undefined, parentCtx);
    child.end(); // child closes before its parent
    root.end();

    expect(traces).toHaveLength(1);
    const [delivered] = traces;
    expect(delivered!.spans).toHaveLength(2);

    const childNode = delivered!.spans.find((s) => s.id === child.spanContext().spanId);
    expect(childNode).toMatchObject({ parentId: root.spanContext().spanId, type: "step" });
  });

  it("records a span still open when its root closes as status: unset", () => {
    const { destination, traces } = recordingDestination();
    const { tracer } = setup(destination);

    const root = tracer.startSpan("run");
    const parentCtx = trace.setSpan(otelContext.active(), root);
    const abandoned = tracer.startSpan("fire-and-forget", undefined, parentCtx);
    // `abandoned` never gets `.end()` — the run finishes without it.
    root.end();

    const [delivered] = traces;
    const node = delivered!.spans.find((s) => s.id === abandoned.spanContext().spanId);
    expect(node).toMatchObject({ status: "unset" });
    expect(node?.endTime).toBeUndefined();
    expect(node?.durationMs).toBeUndefined();
  });

  it("un-flattens attributes into nested metadata", () => {
    const { destination, traces } = recordingDestination();
    const { tracer } = setup(destination);

    const root = tracer.startSpan("chat gpt-5.4");
    root.setAttribute("gen_ai.request.model", "gpt-5.4");
    root.setAttribute("gen_ai.usage.input_tokens", 12);
    root.end();

    expect(traces[0]!.spans[0]!.metadata).toEqual({
      gen_ai: { request: { model: "gpt-5.4" }, usage: { input_tokens: 12 } },
    });
  });

  it("captures a recorded exception as a structured SpanError", () => {
    const { destination, traces } = recordingDestination();
    const { tracer } = setup(destination);

    const root = tracer.startSpan("chat gpt-5.4");
    root.recordException(new TypeError("model refused"));
    root.setStatus({ code: SpanStatusCode.ERROR, message: "model refused" });
    root.end();

    const node = traces[0]!.spans[0]!;
    expect(node.status).toBe("error");
    expect(node.error).toMatchObject({ name: "TypeError", message: "model refused" });
  });
});

describe("LoomTraceSpanProcessor — no destination", () => {
  it("is a free no-op: spans end without error and nothing is buffered forever", () => {
    const onError = vi.fn();
    const { tracer, processor } = setup(undefined, onError);

    const root = tracer.startSpan("run");
    root.end();

    expect(onError).not.toHaveBeenCalled();
    return expect(processor.shutdown()).resolves.toBeUndefined();
  });
});

describe("LoomTraceSpanProcessor — malformed destination", () => {
  it("reports through onError once and drops spans, rather than throwing", () => {
    const onError = vi.fn();
    const notADestination = {} as unknown as LoomDestination;
    const { tracer } = setup(notADestination, onError);

    expect(() => {
      const root = tracer.startSpan("run");
      root.end();
    }).not.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe("LoomTraceSpanProcessor — async destinations", () => {
  it("forceFlush awaits an in-flight write() before resolving", async () => {
    let resolveWrite: (() => void) | undefined;
    const destination: LoomDestination = {
      write: () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    };
    const { tracer, processor } = setup(destination);

    const root = tracer.startSpan("run");
    root.end();

    let flushed = false;
    const flush = processor.forceFlush().then(() => {
      flushed = true;
    });

    await Promise.resolve(); // let microtasks settle
    expect(flushed).toBe(false); // write() has not resolved yet

    resolveWrite?.();
    await flush;
    expect(flushed).toBe(true);
  });

  it("reports a rejected write() through onError instead of throwing", async () => {
    const onError = vi.fn();
    const destination: LoomDestination = {
      write: () => Promise.reject(new Error("disk full")),
    };
    const { tracer, processor } = setup(destination, onError);

    const root = tracer.startSpan("run");
    root.end();

    await processor.forceFlush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].message).toBe("disk full");
  });

  it("drains writes a destination's own settling adds mid-flush, not just one snapshot", async () => {
    // A destination that traces its own work: settling the first write is
    // what triggers the second span to end and be written. `forceFlush()`
    // must not return until that second write is done too — the same
    // drain-loop requirement `LoomTrace.flush()` already has to handle.
    let secondEnded = false;
    const state: { secondRoot?: Span } = {};

    const destination: LoomDestination = {
      write: vi.fn((trace: TraceNode) => {
        if (trace.name === "first") {
          return Promise.resolve().then(() => {
            state.secondRoot?.end();
          });
        }
        secondEnded = true;
        return Promise.resolve();
      }),
    };
    const { tracer, processor } = setup(destination);

    state.secondRoot = tracer.startSpan("second");
    tracer.startSpan("first").end();

    await processor.forceFlush();

    expect(secondEnded).toBe(true);
    expect(destination.write).toHaveBeenCalledTimes(2);
  });
});

describe("LoomTraceSpanProcessor — shutdown", () => {
  it("flushes, then calls the destination's shutdown()", async () => {
    const shutdown = vi.fn(async () => {});
    const destination: LoomDestination = { write: () => {}, shutdown };
    const { tracer, processor } = setup(destination);

    tracer.startSpan("run").end();
    await processor.shutdown();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after shutdown resolves", async () => {
    const { destination, traces } = recordingDestination();
    const { tracer, processor } = setup(destination);

    await processor.shutdown();
    tracer.startSpan("too-late").end();

    expect(traces).toHaveLength(0);
  });

  it("drops a trace whose root never sealed, without hanging or throwing", async () => {
    const { destination, traces } = recordingDestination();
    const { tracer, processor } = setup(destination);

    const root = tracer.startSpan("run");
    const parentCtx = trace.setSpan(otelContext.active(), root);
    tracer.startSpan("child-that-outlives-the-run", undefined, parentCtx);
    // `root` never ends — nothing seals this trace.

    await expect(processor.shutdown()).resolves.toBeUndefined();
    expect(traces).toHaveLength(0);
  });
});
