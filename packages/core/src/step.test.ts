import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoomSpan } from "./api.js";
import type { LoomDestination } from "./destinations/destination.js";
import { LoomTrace } from "./loomtrace.js";
import type { SpanNode, TraceNode } from "./schema.js";

/** A destination that keeps what it is given, so a test can look at it. */
function collector(): LoomDestination & { traces: TraceNode[] } {
  const traces: TraceNode[] = [];
  return { name: "collector", traces, write: (trace) => void traces.push(trace) };
}

/** The single trace a test's tracer produced. */
function only(destination: { traces: TraceNode[] }): TraceNode {
  expect(destination.traces).toHaveLength(1);
  return destination.traces[0]!;
}

/** Find a span by name — tests name their spans distinctly. */
function span(trace: TraceNode, name: string): SpanNode {
  const found = trace.spans.filter((s) => s.name === name);
  if (found.length !== 1) {
    throw new Error(`expected one span named ${name}, found ${found.length}`);
  }
  return found[0]!;
}

describe("LoomTrace.step — inside a run", () => {
  it("records a child of the run's root span", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("root", () => {
      tracer.step("child", () => "value");
    });

    const trace = only(destination);
    expect(trace.spans).toHaveLength(2);
    expect(span(trace, "child")).toMatchObject({
      parentId: span(trace, "root").id,
      type: "step",
      status: "ok",
      output: "value",
    });
  });

  it("returns the callback's value, sync and async", async () => {
    const tracer = new LoomTrace({ destination: collector() });

    await tracer.run("root", async () => {
      expect(tracer.step("sync", () => 42)).toBe(42);
      await expect(tracer.step("async", async () => "later")).resolves.toBe("later");
    });
  });

  it("nests steps to any depth", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("root", () => {
      tracer.step("outer", () => {
        tracer.step("inner", () => {
          tracer.step("innermost", () => null);
        });
      });
    });

    const trace = only(destination);
    expect(trace.spans).toHaveLength(4);
    expect(span(trace, "outer").parentId).toBe(span(trace, "root").id);
    expect(span(trace, "inner").parentId).toBe(span(trace, "outer").id);
    expect(span(trace, "innermost").parentId).toBe(span(trace, "inner").id);
    // Flat list, parentage in a field — DESIGN 2.1.
    expect(trace.spans.every((s) => !("spans" in s))).toBe(true);
  });

  it("follows the run across awaits", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("root", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await tracer.step("after-await", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        tracer.step("deep", () => null);
      });
    });

    const trace = only(destination);
    expect(span(trace, "after-await").parentId).toBe(span(trace, "root").id);
    expect(span(trace, "deep").parentId).toBe(span(trace, "after-await").id);
  });

  it("closes a child before the run that contains it", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("root", async () => {
      await tracer.step("child", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    });

    const trace = only(destination);
    const child = span(trace, "child");
    const root = span(trace, "root");

    expect(child.durationMs).toBeGreaterThanOrEqual(4);
    expect(root.durationMs!).toBeGreaterThanOrEqual(child.durationMs!);
    expect(child.startTime >= root.startTime).toBe(true);
    expect(child.endTime! <= root.endTime!).toBe(true);
  });

  it("shares the trace id with every span in the run", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    const ids = tracer.run("root", (root) => {
      const child = tracer.step("child", (s) => s);
      return [root, child];
    });

    const trace = only(destination);
    expect(ids.map((s) => s.traceId)).toEqual([trace.id, trace.id]);
    expect(ids[1]!.parentId).toBe(ids[0]!.id);
  });

  it("takes options like a run does", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("root", () => {
      tracer.step(
        "generate",
        { type: "llm", input: { prompt: "why?" }, metadata: { model: "opus" } },
        (s) => {
          s.setMetadata({ tokens: 12 });
          s.setOutput({ answer: "because" });
          return "raw";
        },
      );
    });

    expect(span(only(destination), "generate")).toMatchObject({
      type: "llm",
      input: { prompt: "why?" },
      output: { answer: "because" },
      metadata: { model: "opus", tokens: 12 },
    });
  });
});

describe("LoomTrace.step — failures", () => {
  it("records a throwing step and lets the run catch it", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const boom = new Error("step failed");

    tracer.run("root", () => {
      expect(() =>
        tracer.step("child", () => {
          throw boom;
        }),
      ).toThrow(boom);
    });

    const trace = only(destination);
    expect(span(trace, "child")).toMatchObject({
      status: "error",
      error: { name: "Error", message: "step failed" },
    });
    // The run handled it, so the run succeeded.
    expect(trace.status).toBe("ok");
    expect(span(trace, "root").status).toBe("ok");
  });

  it("marks both spans when a step's failure escapes the run", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await expect(
      tracer.run("root", async () =>
        tracer.step("child", async () => {
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");

    const trace = only(destination);
    expect(span(trace, "child").status).toBe("error");
    expect(span(trace, "root").status).toBe("error");
    expect(trace.status).toBe("error");
  });

  it("leaves an unfinished step as unset rather than dropping it", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    let release!: () => void;

    tracer.run("root", () => {
      // Started and deliberately not awaited: the run ends first.
      void tracer.step("detached", () => new Promise<void>((r) => (release = r)));
    });

    const trace = only(destination);
    const detached = span(trace, "detached");
    expect(detached.status).toBe("unset");
    expect(detached).not.toHaveProperty("endTime");

    // Closing after the trace was handed over must not write into it — the
    // destination owns that object now.
    release();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(span(only(destination), "detached").status).toBe("unset");
  });

  it("does not record a step opened after its run finished", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    const root = tracer.run("root", (s) => s);
    const value = root.step("too-late", () => "value");

    expect(value).toBe("value");
    expect(only(destination).spans).toHaveLength(1);
  });
});

describe("LoomTrace.step — outside a run", () => {
  it("runs the callback, records nothing, and reports it", () => {
    const destination = collector();
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination, onError });

    expect(tracer.step("orphan", () => "value")).toBe("value");
    expect(destination.traces).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(
      /step\("orphan"\) was called outside of a run/,
    );
  });

  it("hands the callback an inert span", () => {
    const tracer = new LoomTrace({ destination: collector(), onError() {} });

    const span = tracer.step("orphan", (s) => s);

    expect(span.traceId).toBe("0".repeat(32));
    expect(span.parentId).toBeNull();
  });

  it("says nothing when tracing is off entirely", () => {
    const onError = vi.fn();
    const tracer = new LoomTrace({ enabled: false, onError });

    expect(tracer.step("orphan", () => "value")).toBe("value");
    // Nothing is being recorded anyway, so an unrecorded step is not news.
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not leak the run's context out of the run", () => {
    const destination = collector();
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination, onError });

    tracer.run("root", () => null);
    tracer.step("after", () => null);

    expect(only(destination).spans).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("span.step — an explicit parent", () => {
  const timers: NodeJS.Timeout[] = [];

  afterEach(() => {
    timers.splice(0).forEach(clearInterval);
  });

  /**
   * A worker whose callbacks run outside the caller's async context, the way a
   * queue consumer or an event emitter registered at startup does. The interval
   * is created before any run, so `AsyncLocalStorage` has nothing to propagate
   * into it — which is the situation `span.step()` exists for.
   */
  function detachedWorker(): (job: () => void) => void {
    const queue: Array<() => void> = [];
    timers.push(setInterval(() => queue.splice(0).forEach((job) => job()), 1));
    return (job) => void queue.push(job);
  }

  it("attaches to the span it was called on, not the ambient one", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const onError = vi.fn();
    const submit = detachedWorker();

    await new LoomTrace({ destination: collector(), onError }).run("unrelated", () => null);

    await tracer.run("root", async (root) => {
      await tracer.step("outer", async () => {
        await new Promise<void>((resolve) => {
          submit(() => {
            root.step("from-worker", () => "value");
            resolve();
          });
        });
      });
    });

    const trace = only(destination);
    expect(span(trace, "from-worker").parentId).toBe(span(trace, "root").id);
    expect(span(trace, "from-worker").type).toBe("step");
  });

  it("becomes the ambient span for its own callback", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("root", (root) => {
      root.step("explicit", () => {
        tracer.step("ambient", () => null);
      });
    });

    const trace = only(destination);
    expect(span(trace, "ambient").parentId).toBe(span(trace, "explicit").id);
  });

  it("keeps two tracers in one process apart", () => {
    const first = collector();
    const second = collector();
    const onError = vi.fn();
    const a = new LoomTrace({ destination: first, onError });
    const b = new LoomTrace({ destination: second, onError });

    a.run("a-root", () => {
      // `b` has no run of its own open, so this is an orphan step for `b` —
      // it must not attach itself to `a`'s run.
      b.step("b-step", () => null);
      a.step("a-step", () => null);
    });

    expect(only(first).spans.map((s) => s.name)).toEqual(["a-root", "a-step"]);
    expect(second.traces).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("is inert on a span from a disabled tracer", () => {
    const tracer = new LoomTrace({ enabled: false });

    const value = tracer.run("root", (root) => root.step("child", () => "value"));

    expect(value).toBe("value");
  });

  it("is available on the handle a step receives", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    let captured: LoomSpan | undefined;

    tracer.run("root", () => {
      tracer.step("child", (child) => {
        captured = child;
        child.step("grandchild", () => null);
      });
    });

    const trace = only(destination);
    expect(captured!.id).toBe(span(trace, "child").id);
    expect(span(trace, "grandchild").parentId).toBe(span(trace, "child").id);
  });
});
