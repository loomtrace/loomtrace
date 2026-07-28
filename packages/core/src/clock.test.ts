import { describe, expect, it } from "vitest";

import { durationMs, formatTimestamp, now } from "./clock.js";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;

describe("formatTimestamp", () => {
  it("renders nine fractional digits", () => {
    expect(formatTimestamp(now())).toMatch(TIMESTAMP);
  });

  it("keeps sub-millisecond digits that Date would drop", () => {
    // 2026-07-28T11:22:33.123456789Z
    const nanos = BigInt(Date.UTC(2026, 6, 28, 11, 22, 33)) * 1_000_000n + 123_456_789n;

    expect(formatTimestamp(nanos)).toBe("2026-07-28T11:22:33.123456789Z");
  });

  it("pads a whole millisecond out to nine digits", () => {
    const nanos = BigInt(Date.UTC(2026, 6, 28, 0, 0, 0)) * 1_000_000n;

    expect(formatTimestamp(nanos)).toBe("2026-07-28T00:00:00.000000000Z");
  });

  it("orders lexicographically the way it orders chronologically", () => {
    const base = BigInt(Date.UTC(2026, 6, 28)) * 1_000_000n;
    const instants = [base + 999_999_999n, base, base + 1n, base + 1_000_000n];

    const byString = instants.map(formatTimestamp).slice().sort();
    const byTime = [...instants].sort((a, b) => (a < b ? -1 : 1)).map(formatTimestamp);

    expect(byString).toEqual(byTime);
  });
});

describe("now", () => {
  it("is within a second of the wall clock", () => {
    const drift = Number(now() / 1_000_000n) - Date.now();

    expect(Math.abs(drift)).toBeLessThan(1000);
  });

  it("never goes backwards", () => {
    const first = now();
    const second = now();

    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe("durationMs", () => {
  it("is fractional, so a fast span is not zero", () => {
    expect(durationMs(0n, 250_000n)).toBe(0.25);
  });

  it("measures elapsed milliseconds", () => {
    expect(durationMs(1_000_000n, 3_500_000n)).toBe(2.5);
  });
});
