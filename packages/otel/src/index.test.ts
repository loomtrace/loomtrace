import { describe, expect, it } from "vitest";

import { TARGET_SCHEMA_VERSION } from "./index.js";

describe("@loomtrace/otel skeleton", () => {
  it("re-exports the core schema version", () => {
    expect(TARGET_SCHEMA_VERSION).toBe("0.1.0");
  });
});
