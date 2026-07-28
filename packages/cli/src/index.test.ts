import { describe, expect, it } from "vitest";

import { run } from "./index.js";

describe("@loomtrace/cli skeleton", () => {
  it("prints usage with no arguments", () => {
    const result = run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("loomtrace inspect");
  });

  it("fails on an unknown command", () => {
    const result = run(["nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('unknown command "nope"');
  });
});
