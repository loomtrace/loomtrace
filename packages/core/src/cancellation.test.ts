/**
 * Item 3.6: timeouts and cancellation.
 *
 * An agent that abandons a slow tool call and tries something else is working
 * correctly, and a trace that files that under the same heading as a crash is
 * lying about what happened. The decision — DESIGN 4.11 — is that a cancelled
 * span keeps `status: "error"` and gains `cancelled: true`, so the two are
 * distinguishable without a fourth status that every reader would have to learn.
 */

import { describe, expect, it, vi } from "vitest";

import type { LoomDestination } from "./destinations/destination.js";
import { isCancellation } from "./errors.js";
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Work that can be interrupted the way `fetch` can: it rejects with the
 * signal's reason, whatever the caller made that.
 */
function abortable(ms: number, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => resolve("finished"), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

describe("isCancellation — recognizing an abort by shape", () => {
  it("recognizes the DOMException a real abort produces", () => {
    const controller = new AbortController();
    controller.abort();

    expect(controller.signal.reason).toBeInstanceOf(DOMException);
    expect(isCancellation(controller.signal.reason)).toBe(true);
  });

  it("recognizes a timeout", () => {
    expect(isCancellation(new DOMException("timed out", "TimeoutError"))).toBe(
      true,
    );
  });

  it("recognizes Node's abort code, and axios's", () => {
    expect(isCancellation(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }))).toBe(true);
    expect(
      isCancellation(Object.assign(new Error("canceled"), { code: "ERR_CANCELED" })),
    ).toBe(true);
  });

  it("recognizes either spelling of a cancellation error's name", () => {
    for (const name of ["CanceledError", "CancelledError"]) {
      expect(isCancellation(Object.assign(new Error("x"), { name }))).toBe(true);
    }
  });

  it("recognizes an abort from another realm, which fails instanceof", () => {
    // What a signal aborted inside a worker or a `vm` context looks like by the
    // time it reaches here: the right shape, the wrong prototype.
    const foreign = { name: "AbortError", message: "This operation was aborted" };

    expect(foreign instanceof Error).toBe(false);
    expect(isCancellation(foreign)).toBe(true);
  });

  it("does not mistake an ordinary failure for one", () => {
    expect(isCancellation(new TypeError("x is not a function"))).toBe(false);
    expect(isCancellation(new Error("ECONNREFUSED"))).toBe(false);
    expect(isCancellation("AbortError")).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
    expect(isCancellation(null)).toBe(false);
    expect(isCancellation({})).toBe(false);
  });

  it("does not match a message that merely says the word", () => {
    expect(isCancellation(new Error("the user aborted the run"))).toBe(false);
  });

  it("finds an abort a framework wrapped on its way up", () => {
    const wrapped = new Error("generation failed", {
      cause: new Error("request failed", {
        cause: new DOMException("aborted", "AbortError"),
      }),
    });

    expect(isCancellation(wrapped)).toBe(true);
  });

  it("stops following a chain at the same depth toSpanError does", () => {
    let error = new DOMException("aborted", "AbortError") as Error;
    for (let i = 0; i < 8; i++) error = new Error(`layer ${i}`, { cause: error });

    expect(isCancellation(error)).toBe(false);
  });

  it("terminates on a cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;

    expect(isCancellation(a)).toBe(false);
  });

  it("survives a value whose properties throw when read", () => {
    const hostile = {
      get name(): string {
        throw new Error("nope");
      },
      get cause(): unknown {
        throw new Error("nope");
      },
    };

    expect(isCancellation(hostile)).toBe(false);
  });

  it("counts an AggregateError only when everything in it was cancelled", () => {
    const abort = (): Error => new DOMException("aborted", "AbortError");

    expect(isCancellation(new AggregateError([abort(), abort()]))).toBe(true);
    // One provider aborted, the other genuinely failed. Calling the whole thing
    // a cancellation would hide the one worth reading.
    expect(isCancellation(new AggregateError([abort(), new Error("500")]))).toBe(
      false,
    );
    expect(isCancellation(new AggregateError([]))).toBe(false);
  });

  it("answers the same for one error listed twice", () => {
    // `Promise.any([p, p])` over a single rejected promise: one object, two
    // entries. The cycle guard is against cycles, not against repeats.
    const abort = new DOMException("aborted", "AbortError");

    expect(isCancellation(new AggregateError([abort, abort]))).toBe(true);
  });
});

describe("a cancelled span", () => {
  it("is an error, marked as cancelled", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();

    const run = tracer.run("fetch-docs", { signal: controller.signal }, () =>
      abortable(1000, controller.signal),
    );
    controller.abort();
    await expect(run).rejects.toThrow(DOMException);

    const trace = only(destination);
    expect(span(trace, "fetch-docs")).toMatchObject({
      status: "error",
      cancelled: true,
      error: { name: "AbortError" },
    });
    // Still timed, like any other span: how long the work ran before it was
    // given up on is the interesting part of a cancellation.
    expect(span(trace, "fetch-docs").durationMs).toBeGreaterThanOrEqual(0);
  });

  it("leaves the flag off an ordinary failure entirely", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    expect(() =>
      tracer.run("broken", () => {
        throw new TypeError("x is not a function");
      }),
    ).toThrow(TypeError);

    const node = span(only(destination), "broken");
    expect(node.status).toBe("error");
    // Absent, not `false`: there is one way to say "not cancelled".
    expect("cancelled" in node).toBe(false);
    expect(only(destination).cancelled).toBeUndefined();
  });

  it("marks a timeout the same way", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const signal = AbortSignal.timeout(2);

    await expect(
      tracer.run("slow-model", { signal }, () => abortable(1000, signal)),
    ).rejects.toThrow();

    expect(span(only(destination), "slow-model")).toMatchObject({
      status: "error",
      cancelled: true,
      error: { name: "TimeoutError" },
    });
  });

  it("marks a sync throw as readily as a rejection", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    expect(() =>
      tracer.run("guard", () => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).toThrow(DOMException);

    expect(span(only(destination), "guard").cancelled).toBe(true);
  });

  it("mirrors the root span's cancellation onto the trace", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();
    controller.abort();

    await expect(
      tracer.run("answer", { signal: controller.signal }, () =>
        abortable(1000, controller.signal),
      ),
    ).rejects.toThrow();

    const trace = only(destination);
    expect(trace.status).toBe("error");
    expect(trace.cancelled).toBe(true);
  });

  it("does not mark the trace when the run recovered from it", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();

    await tracer.run("supervisor", async () => {
      const attempt = tracer.step("first-provider", { signal: controller.signal }, () =>
        abortable(1000, controller.signal),
      );
      controller.abort();
      await attempt.catch(() => "fell back");
      await tracer.step("second-provider", () => "answer");
    });

    const trace = only(destination);
    expect(span(trace, "first-provider").cancelled).toBe(true);
    // DESIGN 4.6: a parent's status follows its own callback. The agent
    // abandoned one provider and succeeded with another, which is a working run.
    expect(trace.status).toBe("ok");
    expect(trace.cancelled).toBeUndefined();
    expect(span(trace, "supervisor").cancelled).toBeUndefined();
  });
});

describe("a cancellation loomtrace could not see in the error", () => {
  it("is caught by the signal when the caller aborted with their own reason", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();

    // `abort(reason)` with a reason of the caller's own: the rejection is that
    // object, and there is nothing abort-shaped left in it.
    const reason = new Error("user navigated away");
    const run = tracer.run("stream", { signal: controller.signal }, () =>
      abortable(1000, controller.signal),
    );
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);

    expect(span(only(destination), "stream")).toMatchObject({
      status: "error",
      cancelled: true,
      error: { message: "user navigated away" },
    });
  });

  it("is missed without the signal, and records a plain failure", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();

    const run = tracer.run("stream", () => abortable(1000, controller.signal));
    controller.abort(new Error("user navigated away"));
    await expect(run).rejects.toThrow("user navigated away");

    // The honest outcome: loomtrace knows what it was told, and it was told
    // nothing here. The error itself is recorded either way.
    const node = span(only(destination), "stream");
    expect(node.status).toBe("error");
    expect(node.cancelled).toBeUndefined();
  });

  it("attributes an unrecognizable failure under an aborted signal to the abort", () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();
    controller.abort();

    // Real clients do this: aborting mid-stream surfaces as `TypeError:
    // terminated` from the socket, not as an `AbortError`. The signal is the
    // caller's statement that this work was under its control, so it wins.
    expect(() =>
      tracer.run("stream", { signal: controller.signal }, () => {
        throw new TypeError("terminated");
      }),
    ).toThrow(TypeError);

    expect(span(only(destination), "stream")).toMatchObject({
      cancelled: true,
      error: { name: "TypeError" },
    });
  });
});

describe("a signal that has nothing to say", () => {
  it("is ignored when the work succeeded before it fired", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();

    // One signal governs a whole request and is aborted as it winds down. The
    // steps that finished before that are not cancellations.
    const value = await tracer.run("request", { signal: controller.signal }, async () => {
      await tracer.step("lookup", { signal: controller.signal }, () => "hit");
      return "answered";
    });
    controller.abort();

    expect(value).toBe("answered");
    const trace = only(destination);
    expect(trace.status).toBe("ok");
    expect(trace.cancelled).toBeUndefined();
    expect(span(trace, "lookup").cancelled).toBeUndefined();
  });

  it("is ignored when the callback handled the abort itself", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();
    controller.abort();

    // A callback that catches its own abort and returns what it managed to
    // collect did not fail, and loomtrace does not overrule it. A partial
    // result that the caller wants labelled is what `setMetadata` is for.
    const value = await tracer.run("stream", { signal: controller.signal }, async () =>
      abortable(1000, controller.signal).catch(() => "partial"),
    );

    expect(value).toBe("partial");
    expect(span(only(destination), "stream")).toMatchObject({
      status: "ok",
      output: "partial",
    });
    expect(only(destination).cancelled).toBeUndefined();
  });

  it("does not break the tracer when reading it throws", () => {
    const destination = collector();
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination, onError });
    const hostile = {
      get aborted(): boolean {
        throw new Error("proxy trap");
      },
    };

    expect(() =>
      tracer.run("guarded", { signal: hostile }, () => {
        throw new Error("real failure");
      }),
    ).toThrow("real failure");

    const node = span(only(destination), "guarded");
    expect(node.status).toBe("error");
    expect(node.cancelled).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("cancellation across the shapes a run can have", () => {
  it("marks a nested run and the outer one the failure escaped", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const signal = AbortSignal.timeout(2);

    await expect(
      tracer.run("supervisor", async () =>
        tracer.run("sub-agent", { signal }, () => abortable(1000, signal)),
      ),
    ).rejects.toThrow();

    const trace = only(destination);
    expect(span(trace, "sub-agent").cancelled).toBe(true);
    // The supervisor did not catch it, so it ended the same way its callee did.
    expect(span(trace, "supervisor").cancelled).toBe(true);
    expect(trace.cancelled).toBe(true);
  });

  it("marks every branch a shared signal took down", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();

    await tracer.run("fan-out", async () => {
      const branches = ["search", "summarize", "rank"].map((name) =>
        tracer.step(name, { signal: controller.signal }, () =>
          abortable(1000, controller.signal),
        ),
      );
      controller.abort();
      await Promise.allSettled(branches);
    });

    const trace = only(destination);
    for (const name of ["search", "summarize", "rank"]) {
      expect(span(trace, name)).toMatchObject({ status: "error", cancelled: true });
    }
  });

  it("leaves a step raced away by a timeout unset rather than cancelled", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    // The other timeout shape: nothing is aborted, the run simply stops waiting.
    // The step is still running when the trace is sealed, so nobody ever learns
    // how it ended — `unset`, and that is the truth. DESIGN 4.8.
    await tracer.run("with-deadline", async () =>
      Promise.race([
        tracer.step("slow-tool", () => sleep(1000)),
        sleep(2).then(() => "gave up"),
      ]),
    );

    const trace = only(destination);
    expect(trace.status).toBe("ok");
    expect(span(trace, "slow-tool")).toMatchObject({ status: "unset" });
    expect(span(trace, "slow-tool").cancelled).toBeUndefined();
    expect(span(trace, "slow-tool").endTime).toBeUndefined();
  });

  it("records a deadline the run itself threw on", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await expect(
      tracer.run("with-deadline", async () =>
        Promise.race([
          sleep(1000),
          sleep(2).then(() => {
            throw new DOMException("deadline exceeded", "TimeoutError");
          }),
        ]),
      ),
    ).rejects.toThrow("deadline exceeded");

    const trace = only(destination);
    expect(trace.cancelled).toBe(true);
    expect(span(trace, "with-deadline")).toMatchObject({
      status: "error",
      cancelled: true,
    });
  });

  it("carries the signal through a nested run's demoted options", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await tracer.run("outer", async () => {
      await tracer
        .run(
          "inner",
          { signal: controller.signal, traceMetadata: { agent: "researcher" } },
          () => abortable(1000, controller.signal),
        )
        .catch(() => undefined);
    });

    const inner = span(only(destination), "inner");
    expect(inner.cancelled).toBe(true);
    expect(inner.metadata).toEqual({ agent: "researcher" });
  });

  it("changes nothing when tracing is off", () => {
    const controller = new AbortController();
    controller.abort();
    const tracer = new LoomTrace({ enabled: false });

    expect(() =>
      tracer.run("guard", { signal: controller.signal }, () => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).toThrow(DOMException);
  });
});
