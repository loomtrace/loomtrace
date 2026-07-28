import { describe, expect, it, vi } from "vitest";

import type { LoomDestination } from "./destination.js";
import { LoomTrace } from "./loomtrace.js";
import type { TraceNode } from "./schema.js";
import { SCHEMA_VERSION } from "./version.js";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;

/** A destination that keeps what it is given, so a test can look at it. */
function collector(): LoomDestination & { traces: TraceNode[] } {
  const traces: TraceNode[] = [];
  return { name: "collector", traces, write: (trace) => void traces.push(trace) };
}

/** The only span of a single-run trace. */
function root(trace: TraceNode) {
  const span = trace.spans[0];
  if (span === undefined) throw new Error("trace has no spans");
  return span;
}

describe("LoomTrace.run — return values", () => {
  it("returns a synchronous value, synchronously", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    const value = tracer.run("sync", () => 42);

    expect(value).toBe(42);
    // The trace is already written: `.run()` around a sync callback must not
    // defer anything to a microtask.
    expect(destination.traces).toHaveLength(1);
  });

  it("returns the callback's promise and waits for it", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    const pending = tracer.run("async", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "done";
    });

    expect(destination.traces).toHaveLength(0);
    await expect(pending).resolves.toBe("done");
    expect(destination.traces).toHaveLength(1);
    expect(root(destination.traces[0]!).durationMs).toBeGreaterThanOrEqual(4);
  });

  it("waits for a non-native thenable", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    const thenable = {
      then(onFulfilled: (value: string) => void) {
        setTimeout(() => onFulfilled("late"), 5);
      },
    };

    await expect(tracer.run("thenable", () => thenable)).resolves.toBe("late");
    expect(destination.traces).toHaveLength(1);
  });

  it("infers the callback's type", () => {
    const tracer = new LoomTrace({ destination: collector() });

    const sync: number = tracer.run("sync", () => 1);
    const async: Promise<string> = tracer.run("async", async () => "one");

    expect(sync).toBe(1);
    return expect(async).resolves.toBe("one");
  });
});

describe("LoomTrace.run — the trace it writes", () => {
  it("writes one trace with one root span", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("answer-question", () => "answer");

    expect(destination.traces).toHaveLength(1);
    const trace = destination.traces[0]!;

    expect(trace.schemaVersion).toBe(SCHEMA_VERSION);
    expect(trace.name).toBe("answer-question");
    expect(trace.status).toBe("ok");
    expect(trace.spans).toHaveLength(1);
    expect(root(trace)).toMatchObject({
      name: "answer-question",
      parentId: null,
      type: "run",
      status: "ok",
      output: "answer",
    });
  });

  it("uses OpenTelemetry-shaped ids", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("a", () => null);
    tracer.run("b", () => null);

    const [first, second] = destination.traces as [TraceNode, TraceNode];

    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
    expect(root(first).id).toMatch(/^[0-9a-f]{16}$/);
    expect(first.id).not.toBe(second.id);
    expect(root(first).id).not.toBe(root(second).id);
  });

  it("timestamps the trace and the root span identically", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("timed", () => null);
    const trace = destination.traces[0]!;

    expect(trace.startTime).toMatch(TIMESTAMP);
    expect(trace.endTime).toMatch(TIMESTAMP);
    expect(trace.startTime).toBe(root(trace).startTime);
    expect(trace.endTime).toBe(root(trace).endTime);
    expect(trace.durationMs).toBe(root(trace).durationMs);
    expect(trace.endTime! >= trace.startTime).toBe(true);
  });

  it("records the span the callback was handed", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    const seen = tracer.run("handles", (span) => span);
    const trace = destination.traces[0]!;

    expect(seen.id).toBe(root(trace).id);
    expect(seen.traceId).toBe(trace.id);
    expect(seen.parentId).toBeNull();
  });
});

describe("LoomTrace.run — input, output, metadata", () => {
  it("takes input, type and metadata from the options", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run(
      "generate",
      { type: "llm", input: { question: "why?" }, metadata: { model: "opus" } },
      () => "because",
    );

    expect(root(destination.traces[0]!)).toMatchObject({
      type: "llm",
      input: { question: "why?" },
      metadata: { model: "opus" },
    });
  });

  it("lets the callback set input, output and metadata", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("explicit", (span) => {
      span.setInput({ question: "why?" });
      span.setMetadata({ hits: 4 });
      span.setMetadata({ cached: true });
      span.setOutput({ answer: "because" });
      return "a Response object, say";
    });

    expect(root(destination.traces[0]!)).toMatchObject({
      input: { question: "why?" },
      // setOutput wins over the return value: that is its purpose.
      output: { answer: "because" },
      metadata: { hits: 4, cached: true },
    });
  });

  it("records no output for a callback that returns nothing", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("void", () => {});

    expect(root(destination.traces[0]!)).not.toHaveProperty("output");
  });

  it("merges instance metadata under run metadata", () => {
    const destination = collector();
    const tracer = new LoomTrace({
      destination,
      metadata: { env: "test", release: "0.0.0" },
    });

    tracer.run("merged", { traceMetadata: { release: "override", user: "u1" } }, () => null);

    expect(destination.traces[0]!.metadata).toEqual({
      env: "test",
      release: "override",
      user: "u1",
    });
  });

  it("omits trace metadata when there is none", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("bare", () => null);

    expect(destination.traces[0]!).not.toHaveProperty("metadata");
  });
});

describe("LoomTrace.run — failures in the callback", () => {
  it("records a synchronous throw and re-throws it unchanged", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const boom = new TypeError("boom");

    expect(() =>
      tracer.run("throws", () => {
        throw boom;
      }),
    ).toThrow(boom);

    const trace = destination.traces[0]!;
    expect(trace.status).toBe("error");
    expect(root(trace).status).toBe("error");
    expect(root(trace).error).toMatchObject({ name: "TypeError", message: "boom" });
    expect(root(trace).error?.stack).toContain("boom");
    expect(root(trace)).not.toHaveProperty("output");
  });

  it("records a rejection and re-throws it unchanged", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const boom = new Error("late boom");

    await expect(tracer.run("rejects", async () => Promise.reject(boom))).rejects.toBe(boom);

    expect(destination.traces[0]!.status).toBe("error");
    expect(root(destination.traces[0]!).error).toMatchObject({ message: "late boom" });
  });

  it("survives a thrown value that is not an Error", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    expect(() =>
      tracer.run("throws-a-string", () => {
        throw "just a string";
      }),
    ).toThrow("just a string");

    expect(root(destination.traces[0]!).error).toEqual({
      name: "string",
      message: "just a string",
    });
  });
});

describe("LoomTrace — when nothing is being recorded", () => {
  it("records nothing by default", () => {
    const tracer = new LoomTrace();

    expect(tracer.run("silent", () => "value")).toBe("value");
  });

  it('records nothing for destination "silent"', () => {
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination: "silent", onError });

    expect(tracer.run("silent", () => "value")).toBe("value");
    expect(onError).not.toHaveBeenCalled();
  });

  it("records nothing when disabled, destination or not", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination, enabled: false });

    expect(tracer.run("disabled", () => "value")).toBe("value");
    expect(destination.traces).toHaveLength(0);
  });

  it("hands the callback an inert span rather than nothing", () => {
    const tracer = new LoomTrace({ enabled: false });

    const span = tracer.run("disabled", (s) => s);

    expect(span.id).toBe("0".repeat(16));
    expect(span.traceId).toBe("0".repeat(32));
    expect(span.parentId).toBeNull();
    // The handle still works; it just does not record.
    expect(() => span.setMetadata({ a: 1 })).not.toThrow();
    expect(span.step("child", () => "child value")).toBe("child value");
  });

  it("still propagates an exception when disabled", () => {
    const tracer = new LoomTrace({ enabled: false });
    const boom = new Error("boom");

    expect(() =>
      tracer.run("disabled", () => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  it('reports that "local" is not implemented yet, once, and keeps working', () => {
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination: "local", onError });

    expect(tracer.run("local", () => "value")).toBe("value");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/not implemented yet/);
  });
});

describe("LoomTrace — failures in the destination", () => {
  it("swallows a synchronous throw from write", () => {
    const onError = vi.fn();
    const tracer = new LoomTrace({
      destination: {
        name: "broken",
        write() {
          throw new Error("disk on fire");
        },
      },
      onError,
    });

    expect(tracer.run("write-throws", () => "value")).toBe("value");
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      "broken.write() failed: disk on fire",
    );
  });

  it("swallows a rejected write without an unhandled rejection", async () => {
    const onError = vi.fn();
    const tracer = new LoomTrace({
      destination: { async write() { throw new Error("network down"); } },
      onError,
    });

    tracer.run("write-rejects", () => "value");
    await tracer.flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      "destination.write() failed: network down",
    );
  });

  it("swallows a throwing onError", () => {
    const tracer = new LoomTrace({
      destination: {
        write() {
          throw new Error("disk on fire");
        },
      },
      onError() {
        throw new Error("and so is the handler");
      },
    });

    expect(tracer.run("both-broken", () => "value")).toBe("value");
  });

  it("degrades to silence when the destination has no write method", () => {
    const onError = vi.fn();
    // What a framework passing a config object where a destination belongs
    // gets: not a crash at construction, which would take down a program that
    // only wanted a log.
    const tracer = new LoomTrace({
      destination: { type: "cloud", apiKey: "…" } as unknown as LoomDestination,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(
      /no write\(\) method/,
    );
    expect(tracer.run("unrecorded", () => "value")).toBe("value");
  });

  it("swallows a rejecting flush and shutdown, naming each", async () => {
    const onError = vi.fn();
    const tracer = new LoomTrace({
      destination: {
        name: "broken",
        write() {},
        flush: () => Promise.reject(new Error("queue stuck")),
        shutdown: () => Promise.reject(new Error("socket already gone")),
      },
      onError,
    });

    tracer.run("recorded", () => null);
    await expect(tracer.flush()).resolves.toBeUndefined();
    await expect(tracer.shutdown()).resolves.toBeUndefined();

    expect(onError.mock.calls.map((call) => (call[0] as Error).message)).toEqual([
      "broken.flush() failed: queue stuck",
      "broken.flush() failed: queue stuck",
      "broken.shutdown() failed: socket already gone",
    ]);
  });

  it("warns on console once by default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracer = new LoomTrace({
      destination: {
        write() {
          throw new Error("disk on fire");
        },
      },
    });

    tracer.run("first", () => null);
    tracer.run("second", () => null);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[loomtrace]");
    warn.mockRestore();
  });
});

describe("LoomTrace — flush and shutdown", () => {
  it("awaits writes still in flight, then the destination's flush", async () => {
    const order: string[] = [];
    let resolveWrite: (() => void) | undefined;

    const tracer = new LoomTrace({
      destination: {
        write: () =>
          new Promise<void>((resolve) => {
            resolveWrite = () => {
              order.push("write");
              resolve();
            };
          }),
        flush: async () => void order.push("flush"),
      },
    });

    tracer.run("slow-write", () => null);
    const flushed = tracer.flush();

    expect(order).toEqual([]);
    resolveWrite!();
    await flushed;

    expect(order).toEqual(["write", "flush"]);
  });

  it("flushes, shuts the destination down once, and stops recording", async () => {
    const destination = {
      traces: [] as TraceNode[],
      write(trace: TraceNode) {
        this.traces.push(trace);
      },
      flush: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const tracer = new LoomTrace({ destination });

    tracer.run("before", () => null);
    await tracer.shutdown();
    await tracer.shutdown();

    expect(destination.shutdown).toHaveBeenCalledTimes(1);
    expect(tracer.run("after", () => "value")).toBe("value");
    expect(destination.traces).toHaveLength(1);
  });

  it("keeps draining when a write hands over another trace", async () => {
    const written: string[] = [];
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    // The destination has to be able to name the tracer that owns it, which
    // does not exist yet at the point it is written.
    const box: { tracer?: LoomTrace } = {};

    // A destination that traces its own work — a plausible thing for one that
    // uploads — is why `flush()` drains in a loop instead of awaiting one
    // snapshot of what was in flight when it was called.
    const tracer = new LoomTrace({
      destination: {
        write(trace) {
          written.push(trace.name);
          if (trace.name === "follow-up") return sleep(2);
          return sleep(1).then(() => void box.tracer?.run("follow-up", () => null));
        },
      },
    });
    box.tracer = tracer;

    tracer.run("first", () => null);
    await tracer.flush();

    expect(written).toEqual(["first", "follow-up"]);
  });

  it("resolves flush when there is no destination", async () => {
    await expect(new LoomTrace().flush()).resolves.toBeUndefined();
    await expect(new LoomTrace().shutdown()).resolves.toBeUndefined();
  });
});
