import { describe, expect, it, vi } from "vitest";

import { describeCause, toSpanError } from "./errors.js";
import { LoomTrace } from "./loomtrace.js";
import type { LoomDestination } from "./destination.js";
import type { TraceNode } from "./schema.js";

function collector(): LoomDestination & { traces: TraceNode[] } {
  const traces: TraceNode[] = [];
  return { name: "collector", traces, write: (trace) => void traces.push(trace) };
}

/** Throw `thrown` inside a run and give back the error recorded for the root span. */
function record(thrown: unknown) {
  const destination = collector();
  const tracer = new LoomTrace({ destination, onError: () => {} });

  expect(() =>
    tracer.run("root", () => {
      throw thrown;
    }),
  ).toThrow();

  return destination.traces[0]!.spans[0]!.error!;
}

describe("toSpanError — errors", () => {
  it("captures name, message and stack", () => {
    const error = toSpanError(new TypeError("bad type"));

    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("bad type");
    expect(error.stack).toContain("bad type");
  });

  it("captures a custom error class by its own name", () => {
    class RateLimitError extends Error {
      override name = "RateLimitError";
    }

    expect(toSpanError(new RateLimitError("slow down")).name).toBe("RateLimitError");
  });

  it("captures an error from another realm, which fails instanceof", () => {
    // What an error looks like when it crosses a `vm` context or a worker
    // boundary: the shape is right, the prototype chain is not ours.
    const crossRealm = Object.assign(Object.create(null), {
      name: "Error",
      message: "from elsewhere",
      stack: "Error: from elsewhere\n    at somewhere",
    });

    expect(crossRealm instanceof Error).toBe(false);
    expect(toSpanError(crossRealm)).toEqual({
      name: "Error",
      message: "from elsewhere",
      stack: "Error: from elsewhere\n    at somewhere",
    });
  });

  it("captures an error with no stack", () => {
    const error = new Error("stackless");
    delete error.stack;

    expect(toSpanError(error)).toEqual({ name: "Error", message: "stackless" });
  });
});

describe("toSpanError — cause chains", () => {
  it("follows cause to the error that actually explains the failure", () => {
    const root = new Error("ECONNREFUSED");
    const middle = new Error("request failed", { cause: root });
    const top = new Error("generation failed", { cause: middle });

    expect(toSpanError(top)).toMatchObject({
      message: "generation failed",
      cause: {
        message: "request failed",
        cause: { message: "ECONNREFUSED" },
      },
    });
  });

  it("follows a cause that is not an error", () => {
    const error = toSpanError(new Error("wrapped", { cause: { status: 429 } }));

    expect(error.cause).toEqual({ name: "Object", message: '{"status":429}' });
  });

  it("stops at a fixed depth", () => {
    let error = new Error("depth-0");
    for (let depth = 1; depth <= 10; depth += 1) {
      error = new Error(`depth-${depth}`, { cause: error });
    }

    let captured = toSpanError(error);
    let depth = 0;
    while (captured.cause !== undefined) {
      captured = captured.cause;
      depth += 1;
    }

    expect(depth).toBe(5);
  });

  it("terminates on a cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;

    const captured = toSpanError(a);

    expect(captured.message).toBe("a");
    expect(captured.cause?.message).toBe("b");
    // `b.cause` is `a`, already captured — the chain ends rather than looping.
    expect(captured.cause?.cause).toBeUndefined();
  });

  it("ignores an absent cause", () => {
    expect(toSpanError(new Error("plain"))).not.toHaveProperty("cause");
  });
});

describe("toSpanError — AggregateError", () => {
  it("records what each of the failures was", () => {
    const aggregate = new AggregateError(
      [new Error("openai down"), new Error("anthropic down")],
      "all providers failed",
    );

    expect(toSpanError(aggregate)).toMatchObject({
      name: "AggregateError",
      message: "all providers failed",
      errors: [{ message: "openai down" }, { message: "anthropic down" }],
    });
  });

  it("truncates a very long list and says so", () => {
    const errors = Array.from({ length: 25 }, (_, i) => new Error(`e${i}`));

    const captured = toSpanError(new AggregateError(errors, "many"));

    expect(captured.errors).toHaveLength(11);
    expect(captured.errors!.at(-1)).toEqual({
      name: "loomtrace",
      message: "15 further errors were not recorded",
    });
  });

  it("comes out of Promise.any with the individual reasons intact", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await expect(
      tracer.run("retry-across-providers", async () =>
        Promise.any([
          Promise.reject(new Error("openai down")),
          Promise.reject(new Error("anthropic down")),
        ]),
      ),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(destination.traces[0]!.spans[0]!.error!.errors).toMatchObject([
      { message: "openai down" },
      { message: "anthropic down" },
    ]);
  });
});

describe("toSpanError — values that are not errors at all", () => {
  it("records a thrown string", () => {
    expect(record("just a string")).toEqual({
      name: "string",
      message: "just a string",
    });
  });

  it("records a thrown number, null and undefined", () => {
    expect(toSpanError(404)).toEqual({ name: "number", message: "404" });
    expect(toSpanError(null)).toEqual({ name: "object", message: "null" });
    expect(toSpanError(undefined)).toEqual({
      name: "undefined",
      message: "undefined",
    });
  });

  it("records a thrown symbol without throwing", () => {
    expect(toSpanError(Symbol("nope"))).toEqual({
      name: "symbol",
      message: "Symbol(nope)",
    });
  });

  it("records a thrown payload as JSON, not as [object Object]", () => {
    expect(record({ code: "rate_limit", retryAfter: 30 })).toEqual({
      name: "Object",
      message: '{"code":"rate_limit","retryAfter":30}',
    });
  });

  it("names a thrown class instance after its class", () => {
    class Refusal {
      readonly reason = "policy";
    }

    expect(toSpanError(new Refusal())).toEqual({
      name: "Refusal",
      message: '{"reason":"policy"}',
    });
  });

  it("survives a value that cannot be serialized", () => {
    const circular: Record<string, unknown> = { self: undefined };
    circular.self = circular;

    const captured = toSpanError(circular);

    expect(captured.name).toBe("Object");
    expect(captured.message).toBe("[object Object]");
  });

  it("survives getters that throw", () => {
    const hostile = {
      get name(): string {
        throw new Error("no name for you");
      },
      get message(): string {
        throw new Error("no message either");
      },
      get stack(): string {
        throw new Error("nor a stack");
      },
      get cause(): unknown {
        throw new Error("nor a cause");
      },
    };

    expect(() => toSpanError(hostile)).not.toThrow();
    expect(toSpanError(hostile).name).toBe("Object");
  });

  it("survives an object with no prototype and no toString", () => {
    const bare = Object.create(null) as object;

    expect(() => toSpanError(bare)).not.toThrow();
    expect(toSpanError(bare).name).toBe("Object");
  });
});

describe("describeCause", () => {
  it("prefers an error's message", () => {
    expect(describeCause(new Error("disk on fire"))).toBe("disk on fire");
  });

  it("falls back to a string form for anything else", () => {
    expect(describeCause(404)).toBe("404");
    expect(describeCause(Symbol("s"))).toBe("Symbol(s)");
  });
});

describe("LoomTrace — an exception is never swallowed or replaced", () => {
  it("re-throws the caller's error even when the destination throws", () => {
    const onError = vi.fn();
    const tracer = new LoomTrace({
      destination: {
        write() {
          throw new Error("write failed");
        },
      },
      onError,
    });
    const boom = new Error("callback failed");

    expect(() =>
      tracer.run("root", () => {
        throw boom;
      }),
    ).toThrow(boom);
    // The destination's failure went to `onError`, not to the caller.
    expect((onError.mock.calls[0]![0] as Error).message).toContain("write failed");
  });

  it("re-throws the caller's rejection when the destination throws", async () => {
    const boom = new Error("callback failed");
    const tracer = new LoomTrace({
      destination: {
        write() {
          throw new Error("write failed");
        },
      },
      onError() {},
    });

    await expect(
      tracer.run("root", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("keeps a step's error identical through the run that re-throws it", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const boom = new Error("step failed");

    await expect(
      tracer.run("root", async () => tracer.step("child", async () => Promise.reject(boom))),
    ).rejects.toBe(boom);

    const [root, child] = destination.traces[0]!.spans;
    expect(child!.error).toMatchObject({ message: "step failed" });
    expect(root!.error).toMatchObject({ message: "step failed" });
  });

  it("runs the callback untraced when opening a span fails", () => {
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination: collector(), onError });
    const randomValues = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(() => {
        throw new Error("no entropy");
      });

    try {
      expect(tracer.run("root", () => "value")).toBe("value");
    } finally {
      randomValues.mockRestore();
    }

    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      "internal failure while starting a run: no entropy",
    );
  });

  it("records nothing for the error of a span that did not fail", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    tracer.run("root", () => "fine");

    expect(destination.traces[0]!.spans[0]!).not.toHaveProperty("error");
  });
});
