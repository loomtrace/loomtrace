/**
 * Item 3.5: a `.run()` inside a `.run()`.
 *
 * This is the shape of an agent calling another agent: both are complete
 * executions, both were written as a `.run()` by whoever wrote them, and
 * neither knows about the other. The decision — DESIGN 4.10 — is that the inner
 * one joins the outer trace as a child span rather than starting a trace of its
 * own, so the causal chain survives the call.
 */

import { describe, expect, it, vi } from "vitest";

import type { LoomDestination } from "./destination.js";
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

/** The name of a span's parent, which is what these tests actually assert on. */
function parentOf(trace: TraceNode, name: string): string | null {
  const parentId = span(trace, name).parentId;
  if (parentId === null) return null;
  const parent = trace.spans.find((s) => s.id === parentId);
  if (parent === undefined) throw new Error(`${name} has a parent outside the trace`);
  return parent.name;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("nested run — one trace, not two", () => {
  it("attaches an inner run to the outer run as a child span", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("outer", () => {
      tracer.run("inner", () => "value");
    });

    const trace = only(destination);
    expect(trace.name).toBe("outer");
    expect(trace.spans).toHaveLength(2);
    expect(span(trace, "inner")).toMatchObject({
      parentId: span(trace, "outer").id,
      status: "ok",
      output: "value",
    });
    expect(trace.spans.filter((s) => s.parentId === null)).toHaveLength(1);
  });

  it("keeps type run on the nested span, so the boundary is visible", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("outer", () => {
      tracer.step("plain-step", () => {
        tracer.run("inner", () => null);
      });
    });

    const trace = only(destination);
    expect(span(trace, "inner").type).toBe("run");
    expect(span(trace, "plain-step").type).toBe("step");
    expect(parentOf(trace, "inner")).toBe("plain-step");
  });

  it("gives the nested run the outer trace's id", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    const [outer, inner] = tracer.run("outer", (o) => [
      o,
      tracer.run("inner", (i) => i),
    ]);

    const trace = only(destination);
    expect(inner!.traceId).toBe(trace.id);
    expect(inner!.traceId).toBe(outer!.traceId);
    expect(inner!.parentId).toBe(outer!.id);
  });

  it("nests to any depth, in one trace", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("agent-1", () => {
      tracer.run("agent-2", () => {
        tracer.run("agent-3", () => {
          tracer.step("leaf", () => null);
        });
      });
    });

    const trace = only(destination);
    expect(trace.spans).toHaveLength(4);
    expect(parentOf(trace, "agent-2")).toBe("agent-1");
    expect(parentOf(trace, "agent-3")).toBe("agent-2");
    expect(parentOf(trace, "leaf")).toBe("agent-3");
  });

  it("parents a nested run's steps to it, not to the outer run", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("outer", async () => {
      await tracer.step("before", () => null);
      await tracer.run("inner", async () => {
        await sleep(1);
        await tracer.step("inside", () => null);
      });
      await tracer.step("after", () => null);
    });

    const trace = only(destination);
    expect(parentOf(trace, "before")).toBe("outer");
    expect(parentOf(trace, "inside")).toBe("inner");
    // The inner run's frame is gone once its callback settles.
    expect(parentOf(trace, "after")).toBe("outer");
  });

  it("keeps sibling runs as separate traces", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("first", () => null);
    tracer.run("second", () => null);

    expect(destination.traces.map((t) => t.name)).toEqual(["first", "second"]);
    expect(destination.traces[0]!.id).not.toBe(destination.traces[1]!.id);
  });

  it("does not nest into another tracer's run", () => {
    const outerDestination = collector();
    const innerDestination = collector();
    const outer = new LoomTrace({ destination: outerDestination });
    const inner = new LoomTrace({ destination: innerDestination });

    outer.run("outer", () => {
      inner.run("inner", () => null);
    });

    // Per-instance storage — DESIGN 4.7. Two frameworks that each embed
    // loomtrace produce two independent traces, not one merged one.
    expect(only(outerDestination).spans.map((s) => s.name)).toEqual(["outer"]);
    expect(only(innerDestination).spans.map((s) => s.name)).toEqual(["inner"]);
  });
});

describe("nested run — options and metadata", () => {
  it("folds the nested run's traceMetadata into its span metadata", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination, metadata: { env: "test" } });

    tracer.run("outer", { traceMetadata: { session: "outer-session" } }, () => {
      tracer.run(
        "inner",
        { traceMetadata: { session: "inner-session", agent: "researcher" } },
        () => null,
      );
    });

    const trace = only(destination);
    // The outer trace's own annotations are untouched: a sub-agent does not get
    // to relabel the execution that called it.
    expect(trace.metadata).toEqual({ env: "test", session: "outer-session" });
    expect(span(trace, "inner").metadata).toEqual({
      session: "inner-session",
      agent: "researcher",
    });
  });

  it("lets span metadata win over the demoted trace metadata", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("outer", () => {
      tracer.run(
        "inner",
        { traceMetadata: { source: "trace", only: "trace" }, metadata: { source: "span" } },
        (s) => s.setMetadata({ added: true }),
      );
    });

    expect(span(only(destination), "inner").metadata).toEqual({
      source: "span",
      only: "trace",
      added: true,
    });
  });

  it("carries input, output and an explicit type through", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("outer", () => {
      tracer.run("inner", { type: "tool", input: { q: "why?" } }, (s) => {
        s.setOutput({ answer: "because" });
        return "raw";
      });
    });

    expect(span(only(destination), "inner")).toMatchObject({
      type: "tool",
      input: { q: "why?" },
      output: { answer: "because" },
    });
  });
});

describe("nested run — failures and lifetimes", () => {
  it("marks the nested span and lets the outer run catch it", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("outer", () => {
      expect(() =>
        tracer.run("inner", () => {
          throw new Error("sub-agent failed");
        }),
      ).toThrow("sub-agent failed");
    });

    const trace = only(destination);
    expect(span(trace, "inner")).toMatchObject({
      status: "error",
      error: { message: "sub-agent failed" },
    });
    // The caller recovered, so the run as a whole succeeded — DESIGN 4.6.
    expect(trace.status).toBe("ok");
  });

  it("marks both when the nested failure escapes", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await expect(
      tracer.run("outer", async () =>
        tracer.run("inner", async () => {
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");

    const trace = only(destination);
    expect(span(trace, "inner").status).toBe("error");
    expect(span(trace, "outer").status).toBe("error");
    expect(trace.status).toBe("error");
  });

  it("closes the nested run inside its parent's lifetime", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("outer", async () => {
      await tracer.run("inner", async () => sleep(5));
    });

    const trace = only(destination);
    const outer = span(trace, "outer");
    const inner = span(trace, "inner");
    expect(inner.durationMs).toBeGreaterThanOrEqual(4);
    expect(inner.startTime >= outer.startTime).toBe(true);
    expect(inner.endTime! <= outer.endTime!).toBe(true);
    // Only the root span seals and delivers the trace.
    expect(destination.traces).toHaveLength(1);
  });

  it("runs concurrent nested runs as siblings in one trace", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("supervisor", async () => {
      await Promise.all(
        ["researcher", "writer"].map((agent) =>
          tracer.run(agent, async () => {
            await sleep(agent === "researcher" ? 4 : 1);
            await tracer.step(`${agent}-work`, () => null);
          }),
        ),
      );
    });

    const trace = only(destination);
    expect(trace.spans).toHaveLength(5);
    expect(parentOf(trace, "researcher")).toBe("supervisor");
    expect(parentOf(trace, "writer")).toBe("supervisor");
    expect(parentOf(trace, "researcher-work")).toBe("researcher");
    expect(parentOf(trace, "writer-work")).toBe("writer");
  });

  it("starts a fresh trace when the outer one has already been sealed", async () => {
    const destination = collector();
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination, onError });

    // A fire-and-forget step outlives its run, then calls `.run()`. Its
    // ambient trace is gone — recording into it would mutate an object the
    // destination owns — so the work gets a trace of its own rather than none.
    tracer.run("outer", () => {
      void tracer.step("detached", async () => {
        await sleep(2);
        tracer.run("late", () => null);
      });
    });

    await sleep(20);
    expect(destination.traces.map((t) => t.name)).toEqual(["outer", "late"]);
    expect(span(destination.traces[1]!, "late").parentId).toBeNull();
    expect(destination.traces[0]!.spans).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("still records a nested run after shutdown, having stopped new ones", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const outer = tracer.run("outer", async () => {
      await gate;
      // Shutdown stops traces from starting, not open ones from filling in —
      // the same rule `.step()` follows.
      tracer.run("inner", () => null);
    });

    await tracer.shutdown();
    release();
    await outer;

    expect(tracer.run("after-shutdown", () => "value")).toBe("value");
    const trace = only(destination);
    expect(trace.spans.map((s) => s.name)).toEqual(["outer", "inner"]);
  });
});

describe("nested run — when tracing is off", () => {
  it("is inert all the way down", () => {
    const tracer = new LoomTrace({ enabled: false });

    const value = tracer.run("outer", () =>
      tracer.run("inner", (s) => {
        expect(s.traceId).toBe("0".repeat(32));
        expect(s.parentId).toBeNull();
        return "value";
      }),
    );

    expect(value).toBe("value");
  });
});
