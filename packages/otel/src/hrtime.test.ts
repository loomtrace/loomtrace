import type { HrTime } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { hrTimeDurationMs, hrTimeToEpochNanos, hrTimeToTimestamp } from "./hrtime.js";

describe("hrTimeToEpochNanos", () => {
  it("combines seconds and nanoseconds", () => {
    expect(hrTimeToEpochNanos([1_609_504_210, 150_000_000])).toBe(
      1_609_504_210_150_000_000n,
    );
  });

  it("handles a zero nanosecond component", () => {
    expect(hrTimeToEpochNanos([1_000, 0])).toBe(1_000_000_000_000n);
  });
});

describe("hrTimeToTimestamp", () => {
  it("renders nine fractional digits, matching core's Timestamp format", () => {
    const hrTime: HrTime = [1_753_701_753, 123_456_789];

    expect(hrTimeToTimestamp(hrTime)).toBe("2025-07-28T11:22:33.123456789Z");
  });

  it("keeps sub-millisecond precision Date would drop", () => {
    const hrTime: HrTime = [1_753_701_753, 1];

    expect(hrTimeToTimestamp(hrTime)).toBe("2025-07-28T11:22:33.000000001Z");
  });
});

describe("hrTimeDurationMs", () => {
  it("is fractional, so a fast span is not zero", () => {
    expect(hrTimeDurationMs([0, 0], [0, 250_000])).toBe(0.25);
  });

  it("measures elapsed milliseconds across a second boundary", () => {
    expect(hrTimeDurationMs([0, 999_500_000], [1, 1_500_000])).toBe(2);
  });
});
