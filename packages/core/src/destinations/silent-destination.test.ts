import { describe, expect, expectTypeOf, it } from "vitest";

import type { LoomDestination } from "./destination.js";
import { LoomTrace } from "../loomtrace.js";
import { SilentDestination } from "./silent-destination.js";

describe("SilentDestination", () => {
  it("satisfies LoomDestination", () => {
    expectTypeOf(new SilentDestination()).toExtend<LoomDestination>();
  });

  it("discards whatever it is handed", () => {
    const destination = new SilentDestination();

    expect(
      destination.write({
        schemaVersion: 0,
        id: "a".repeat(32),
        name: "irrelevant",
        startTime: "2026-07-28T00:00:00.000000000Z",
        status: "ok",
        spans: [],
      }),
    ).toBeUndefined();
  });

  it("still produces a real, recorded span — unlike the \"silent\" shorthand", () => {
    // Passed as an object rather than the string, so this goes through the
    // ordinary recording path: ids are generated, the span is timed, and only
    // `write()` throws the result away. Documents the contrast with
    // `destination: "silent"`, which never builds any of that in the first
    // place (see the class doc, and the next test).
    const tracer = new LoomTrace({ destination: new SilentDestination() });

    const span = tracer.run("run", (s) => s);

    expect(span.id).not.toBe("0".repeat(16));
    expect(span.traceId).not.toBe("0".repeat(32));
  });

  it('the "silent" shorthand hands back the shared inert span instead', () => {
    const tracer = new LoomTrace({ destination: "silent" });

    const span = tracer.run("run", (s) => s);

    expect(span.id).toBe("0".repeat(16));
    expect(span.traceId).toBe("0".repeat(32));
  });
});
