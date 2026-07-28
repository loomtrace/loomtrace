import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, SCHEMA_VERSION } from "./index.js";

describe("@loomtrace/core skeleton", () => {
  it("exposes a schema version", () => {
    expect(SCHEMA_VERSION).toBe(0);
  });

  it("exposes the package name", () => {
    expect(PACKAGE_NAME).toBe("@loomtrace/core");
  });
});
