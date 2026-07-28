import { describe, expect, it } from "vitest";

import {
  checkSchemaVersion,
  MIN_READABLE_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from "./version.js";

describe("checkSchemaVersion", () => {
  it("accepts the version this build writes", () => {
    expect(checkSchemaVersion(SCHEMA_VERSION)).toBe("ok");
  });

  it("accepts the oldest version this build can read", () => {
    expect(checkSchemaVersion(MIN_READABLE_SCHEMA_VERSION)).toBe("ok");
  });

  it("rejects a trace from a newer loomtrace", () => {
    expect(checkSchemaVersion(SCHEMA_VERSION + 1)).toBe("too-new");
  });

  it("reports a version below the readable floor as too old", () => {
    // Vacuous while the floor is 0, and that is the point: it starts failing
    // the moment the floor is raised without a migration behind it.
    expect(checkSchemaVersion(MIN_READABLE_SCHEMA_VERSION - 1)).toBe(
      MIN_READABLE_SCHEMA_VERSION > 0 ? "too-old" : "invalid",
    );
  });

  // A trace file is arbitrary JSON until proven otherwise, so this is the
  // first thing that runs on it — before any validation.
  it.each([
    ["missing", undefined],
    ["null", null],
    ["a semver string", "0.1.0"],
    ["a numeric string", "1"],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["an object", { major: 1 }],
  ])("classifies %s as invalid", (_label, value) => {
    expect(checkSchemaVersion(value)).toBe("invalid");
  });
});

describe("SCHEMA_VERSION", () => {
  it("is a non-negative integer", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(0);
  });

  it("is not older than the floor it claims to read", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(MIN_READABLE_SCHEMA_VERSION);
  });
});
