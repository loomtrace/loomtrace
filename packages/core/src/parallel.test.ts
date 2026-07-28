/**
 * Item 3.4: concurrency.
 *
 * `Promise.all` over several `.step()` calls is the shape agent code actually
 * has — fan out to three tools, gather what comes back — and it is the shape
 * that breaks a tracer keeping "the current span" in a field. The tree here is
 * built by the `AsyncLocalStorage` from item 3.2; these tests are what says so,
 * and what will notice if that ever regresses into a mutable field.
 *
 * The other half is what concurrency does to a trace's *edges*: branches that
 * are still running when the run ends, and the promise identity handed back to
 * a caller who is coordinating those branches themselves.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("parallel steps — the tree", () => {
  it("hangs every branch of a Promise.all off the run", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("root", async () => {
      await Promise.all([
        tracer.step("a", async () => sleep(4)),
        tracer.step("b", async () => sleep(2)),
        // A branch that never yields at all, mixed in with ones that do.
        tracer.step("c", () => "immediate"),
      ]);
    });

    const trace = only(destination);
    expect(trace.spans).toHaveLength(4);
    expect(["a", "b", "c"].map((name) => parentOf(trace, name))).toEqual([
      "root",
      "root",
      "root",
    ]);
    expect(trace.spans.every((s) => s.status === "ok")).toBe(true);
  });

  it("keeps each branch's children in that branch, however they interleave", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    // The delays matter. Every step here opens while a sibling branch is
    // already inside a step of its own, so a tracer holding one mutable
    // "current span" would parent at least one of these to the other branch.
    await tracer.run("root", async () => {
      await Promise.all([
        tracer.step("a", async () => {
          await sleep(2);
          await tracer.step("a-1", async () => {
            await sleep(8);
            await tracer.step("a-2", () => null);
          });
        }),
        tracer.step("b", async () => {
          await sleep(4);
          await tracer.step("b-1", async () => {
            await sleep(2);
            await tracer.step("b-2", () => null);
          });
        }),
      ]);
    });

    const trace = only(destination);
    expect(parentOf(trace, "a")).toBe("root");
    expect(parentOf(trace, "a-1")).toBe("a");
    expect(parentOf(trace, "a-2")).toBe("a-1");
    expect(parentOf(trace, "b")).toBe("root");
    expect(parentOf(trace, "b-1")).toBe("b");
    expect(parentOf(trace, "b-2")).toBe("b-1");
  });

  it("follows the run into a then-chain, not just into await", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    // Downlevelled output and older library code fan out like this. The context
    // has to reach a `.then` callback the same way it reaches after an `await`.
    await tracer.run("root", () =>
      sleep(1).then(() =>
        Promise.all([
          tracer.step("x", () => sleep(2).then(() => tracer.step("x-1", () => null))),
          tracer.step("y", () => sleep(1)),
        ]),
      ),
    );

    const trace = only(destination);
    expect(parentOf(trace, "x")).toBe("root");
    expect(parentOf(trace, "y")).toBe("root");
    expect(parentOf(trace, "x-1")).toBe("x");
  });

  it("nests parallelism inside parallelism", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("root", async () => {
      await Promise.all(
        ["a", "b"].map((branch) =>
          tracer.step(branch, async () => {
            await Promise.all(
              [1, 2].map((leaf) =>
                tracer.step(`${branch}-${leaf}`, async () => sleep(leaf)),
              ),
            );
          }),
        ),
      );
    });

    const trace = only(destination);
    expect(trace.spans).toHaveLength(7);
    expect(parentOf(trace, "a-1")).toBe("a");
    expect(parentOf(trace, "a-2")).toBe("a");
    expect(parentOf(trace, "b-1")).toBe("b");
    expect(parentOf(trace, "b-2")).toBe("b");
  });

  it("records branches as overlapping and as contained in the run", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("root", async () => {
      await Promise.all([
        tracer.step("slower", async () => sleep(10)),
        tracer.step("faster", async () => sleep(4)),
      ]);
    });

    const trace = only(destination);
    const root = span(trace, "root");
    const slower = span(trace, "slower");
    const faster = span(trace, "faster");

    // Timestamps are fixed-width, so string order is chronological order —
    // DESIGN 2.2. Overlapping intervals are what makes this concurrency rather
    // than two steps in a row.
    expect(slower.startTime < faster.endTime!).toBe(true);
    expect(faster.startTime < slower.endTime!).toBe(true);

    for (const branch of [slower, faster]) {
      expect(branch.startTime >= root.startTime).toBe(true);
      expect(branch.endTime! <= root.endTime!).toBe(true);
    }
    expect(root.durationMs!).toBeGreaterThanOrEqual(slower.durationMs!);
  });

  it("attaches concurrent span.step() calls to the span they were called on", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    // `span.step()` is the escape hatch for places the context cannot reach,
    // and several of those firing at once must not confuse each other.
    await tracer.run("root", async (root) => {
      await tracer.step("wrapper", async () => {
        await Promise.all([
          root.step("detached-1", async () => sleep(3)),
          root.step("detached-2", async () => sleep(1)),
        ]);
      });
    });

    const trace = only(destination);
    expect(parentOf(trace, "wrapper")).toBe("root");
    expect(parentOf(trace, "detached-1")).toBe("root");
    expect(parentOf(trace, "detached-2")).toBe("root");
  });
});

describe("parallel steps — when a branch fails", () => {
  it("records the failed branch and leaves its siblings alone", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await tracer.run("root", async () => {
      await Promise.allSettled([
        tracer.step("ok-1", async () => sleep(2)),
        tracer.step("fails", async () => {
          await sleep(1);
          throw new Error("branch failed");
        }),
        tracer.step("ok-2", async () => sleep(3)),
      ]);
    });

    const trace = only(destination);
    expect(span(trace, "fails")).toMatchObject({
      status: "error",
      error: { name: "Error", message: "branch failed" },
    });
    expect(span(trace, "ok-1").status).toBe("ok");
    expect(span(trace, "ok-2").status).toBe("ok");
    // The run gathered the failure and carried on, so the run succeeded —
    // DESIGN 4.6.
    expect(trace.status).toBe("ok");
  });

  it("leaves a branch abandoned by a rejected Promise.all as unset", async () => {
    const destination = collector();
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination, onError });

    await expect(
      tracer.run("root", async () => {
        await Promise.all([
          tracer.step("fails", async () => {
            await sleep(1);
            throw new Error("first out");
          }),
          tracer.step("still-running", async () => sleep(30)),
        ]);
      }),
    ).rejects.toThrow("first out");

    const trace = only(destination);
    expect(trace.status).toBe("error");
    expect(span(trace, "fails").status).toBe("error");
    // `Promise.all` rejects on the first failure while the other branch is
    // still going, and the trace is sealed the moment the run ends. The
    // abandoned branch stays in it, unfinished — which is what "unset" is for,
    // and is more honest than dropping it.
    expect(span(trace, "still-running")).toMatchObject({ status: "unset" });
    expect(span(trace, "still-running")).not.toHaveProperty("endTime");

    // It finishes later, into a trace the destination already owns. Nothing
    // may change there — DESIGN 5.1.
    await sleep(40);
    expect(span(only(destination), "still-running").status).toBe("unset");
    expect(onError).not.toHaveBeenCalled();
  });

  it("leaves the loser of a Promise.race as unset, and stops tracing it", async () => {
    const destination = collector();
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination, onError });

    await tracer.run("root", async () =>
      Promise.race([
        tracer.step("winner", async () => sleep(1)),
        tracer.step("loser", async () => {
          await sleep(20);
          // Opened after the run was sealed: it runs, and it is not recorded.
          return tracer.step("after-the-end", () => "value");
        }),
      ]),
    );

    const trace = only(destination);
    expect(span(trace, "winner").status).toBe("ok");
    expect(span(trace, "loser").status).toBe("unset");

    await sleep(30);
    expect(only(destination).spans.map((s) => s.name).sort()).toEqual([
      "loser",
      "root",
      "winner",
    ]);
    // Not an orphan step — its run existed, it just ended first — so there is
    // nothing to report.
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("parallel steps — the traced program is unchanged", () => {
  const listeners: Array<(reason: unknown) => void> = [];

  afterEach(() => {
    listeners.splice(0).forEach((l) => process.off("unhandledRejection", l));
  });

  /** Collect unhandled rejections for the duration of a test. */
  function watchUnhandled(): unknown[] {
    const seen: unknown[] = [];
    const listener = (reason: unknown): void => void seen.push(reason);
    listeners.push(listener);
    process.on("unhandledRejection", listener);
    return seen;
  }

  it("hands back the caller's own promise", async () => {
    const tracer = new LoomTrace({ destination: collector() });
    const original = sleep(1).then(() => "value");

    // Identity, not just equivalence. A caller coordinating branches themselves
    // holds the original; a derived stand-in gives the same rejection two
    // places to be handled, and only one of them will be.
    const returned = tracer.run("root", () => original);

    expect(returned).toBe(original);
    await expect(returned).resolves.toBe("value");
  });

  it("does not orphan the rejection of a promise handled elsewhere", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const unhandled = watchUnhandled();

    await tracer.run("root", async () => {
      const request = Promise.reject(new Error("handled by the caller"));

      // The step exists to time the work; the caller keeps the promise and
      // handles it. Without a tracer this program has no unhandled rejection,
      // and an unhandled rejection ends a Node process by default — so with one
      // it must still have none.
      void tracer.step("timed", () => request);

      await expect(request).rejects.toThrow("handled by the caller");
      await sleep(10);
    });

    expect(unhandled).toEqual([]);
    expect(span(only(destination), "timed").status).toBe("error");
  });

  it("records a dropped branch's failure on its span rather than losing it", async () => {
    const destination = collector();
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination, onError });
    const unhandled = watchUnhandled();

    await tracer.run("root", async () => {
      // Fire-and-forget, and it throws. Watching the promise marks it handled,
      // so this no longer reaches `unhandledRejection` — the error goes onto
      // the span instead, which is where someone will actually find it.
      void tracer.step("dropped", async () => {
        throw new Error("nobody catches this");
      });
      await sleep(10);
    });

    expect(unhandled).toEqual([]);
    expect(span(only(destination), "dropped")).toMatchObject({
      status: "error",
      error: { message: "nobody catches this" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failure that arrived too late for any trace", async () => {
    const destination = collector();
    const onError = vi.fn();
    const tracer = new LoomTrace({ destination, onError });
    const unhandled = watchUnhandled();

    // The same fire-and-forget, but the run ends first, so the trace is sealed
    // and handed over before the branch fails. There is no span left to write
    // to, and swallowing it entirely would be the tracer hiding a failure.
    tracer.run("root", () => {
      void tracer.step("dropped", async () => {
        await sleep(2);
        throw new Error("too late for the trace");
      });
    });

    await sleep(20);
    expect(unhandled).toEqual([]);
    expect(span(only(destination), "dropped").status).toBe("unset");
    expect(onError).toHaveBeenCalledTimes(1);

    const reported = onError.mock.calls[0]![0] as Error;
    expect(reported.message).toMatch(
      /"dropped" failed after its run had already finished/,
    );
    expect((reported.cause as Error).message).toBe("too late for the trace");
  });

  it("returns a non-native thenable as itself", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });
    const thenable = {
      then(onFulfilled: (value: string) => void) {
        setTimeout(() => onFulfilled("late"), 2);
      },
    };

    const returned = tracer.run("root", () => thenable);

    expect(returned).toBe(thenable);
    await expect(returned).resolves.toBe("late");
    expect(span(only(destination), "root")).toMatchObject({
      status: "ok",
      output: "late",
    });
  });
});

describe("parallel runs", () => {
  it("keeps concurrent runs on one tracer in separate traces", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    await Promise.all([
      tracer.run("run-a", async () => {
        await sleep(4);
        await tracer.step("a-step", async () => sleep(2));
      }),
      tracer.run("run-b", async () => {
        await sleep(2);
        await tracer.step("b-step", async () => sleep(4));
      }),
    ]);

    // Delivery order between concurrent traces is not promised — DESIGN 5.1,
    // guarantee 7 — so look them up by name.
    expect(destination.traces).toHaveLength(2);
    const byName = new Map(destination.traces.map((t) => [t.name, t]));
    const a = byName.get("run-a")!;
    const b = byName.get("run-b")!;

    expect(a.id).not.toBe(b.id);
    expect(a.spans.map((s) => s.name)).toEqual(["run-a", "a-step"]);
    expect(b.spans.map((s) => s.name)).toEqual(["run-b", "b-step"]);
    expect(parentOf(a, "a-step")).toBe("run-a");
    expect(parentOf(b, "b-step")).toBe("run-b");
    // Every span carries its own trace's id and nobody else's.
    for (const trace of [a, b]) {
      expect(trace.spans.every((s) => trace.spans.some((p) => p.id === s.parentId || s.parentId === null))).toBe(true);
    }
  });
});

describe("parallel steps — invariants", () => {
  it("holds the schema's tree invariants under a wide fan-out", async () => {
    const destination = collector();
    const tracer = new LoomTrace({ destination });

    // Names encode the expected parentage: "b3.c1.g" must be a child of
    // "b3.c1", whatever order the sixty-odd spans happen to open and close in.
    await tracer.run("root", async () => {
      await Promise.all(
        Array.from({ length: 8 }, (_, branch) =>
          tracer.step(`b${branch}`, async () => {
            await sleep(branch % 3);
            await Promise.all(
              Array.from({ length: 3 }, (_, child) =>
                tracer.step(`b${branch}.c${child}`, async () => {
                  await sleep((branch + child) % 4);
                  await tracer.step(`b${branch}.c${child}.g`, () => null);
                }),
              ),
            );
          }),
        ),
      );
    });

    const trace = only(destination);
    expect(trace.spans).toHaveLength(1 + 8 + 24 + 24);

    const byId = new Map(trace.spans.map((s) => [s.id, s]));
    expect(new Set(byId.keys()).size).toBe(trace.spans.length);
    expect(trace.spans.filter((s) => s.parentId === null)).toHaveLength(1);

    for (const node of trace.spans) {
      expect(node.status).toBe("ok");
      if (node.name === "root") continue;

      const parent = byId.get(node.parentId!);
      expect(parent, `${node.name} has a parent outside the trace`).toBeDefined();

      const expected = node.name.includes(".")
        ? node.name.slice(0, node.name.lastIndexOf("."))
        : "root";
      expect(parent!.name).toBe(expected);
      // A child cannot have outlived a parent that waited for it.
      expect(node.startTime >= parent!.startTime).toBe(true);
      expect(node.endTime! <= parent!.endTime!).toBe(true);
    }
  });
});
