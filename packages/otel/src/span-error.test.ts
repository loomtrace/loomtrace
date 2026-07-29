import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { spanErrorFromEvents } from "./span-error.js";

/** The minimal slice of `ReadableSpan` this module actually reads. */
function fakeErrorSpan(
  overrides: Partial<Pick<ReadableSpan, "events" | "status">>,
): ReadableSpan {
  return {
    events: [],
    status: { code: SpanStatusCode.ERROR },
    ...overrides,
  } as ReadableSpan;
}

describe("spanErrorFromEvents", () => {
  it("builds a SpanError from a recorded exception event", () => {
    const span = fakeErrorSpan({
      events: [
        {
          name: "exception",
          time: [0, 0],
          attributes: {
            "exception.type": "TypeError",
            "exception.message": "x is not a function",
            "exception.stacktrace": "TypeError: x is not a function\n at foo",
          },
        },
      ],
    });

    expect(spanErrorFromEvents(span)).toEqual({
      name: "TypeError",
      message: "x is not a function",
      stack: "TypeError: x is not a function\n at foo",
    });
  });

  it("omits stack when the event carries none", () => {
    const span = fakeErrorSpan({
      events: [
        {
          name: "exception",
          time: [0, 0],
          attributes: { "exception.type": "Error", "exception.message": "boom" },
        },
      ],
    });

    expect(spanErrorFromEvents(span)).toEqual({ name: "Error", message: "boom" });
  });

  it("takes the last exception event, not the first", () => {
    const span = fakeErrorSpan({
      events: [
        {
          name: "exception",
          time: [0, 0],
          attributes: { "exception.type": "NetworkError", "exception.message": "attempt 1" },
        },
        {
          name: "exception",
          time: [1, 0],
          attributes: { "exception.type": "NetworkError", "exception.message": "attempt 2 — fatal" },
        },
      ],
    });

    expect(spanErrorFromEvents(span).message).toBe("attempt 2 — fatal");
  });

  it("ignores non-exception events", () => {
    const span = fakeErrorSpan({
      events: [{ name: "retrying", time: [0, 0], attributes: { attempt: 1 } }],
      status: { code: SpanStatusCode.ERROR, message: "gave up after 3 attempts" },
    });

    expect(spanErrorFromEvents(span)).toEqual({
      name: "Error",
      message: "gave up after 3 attempts",
    });
  });

  it("falls back to the status message when no exception was recorded", () => {
    const span = fakeErrorSpan({
      status: { code: SpanStatusCode.ERROR, message: "upstream returned 500" },
    });

    expect(spanErrorFromEvents(span)).toEqual({
      name: "Error",
      message: "upstream returned 500",
    });
  });

  it("degrades to an empty message rather than throwing when nothing is available", () => {
    const span = fakeErrorSpan({});

    expect(spanErrorFromEvents(span)).toEqual({ name: "Error", message: "" });
  });
});
