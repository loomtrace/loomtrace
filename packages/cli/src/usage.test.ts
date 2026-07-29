import { describe, expect, it } from "vitest";

import { extractUsage, formatUsage } from "./usage.js";

describe("extractUsage", () => {
  it("reads the gen_ai.* shape produced by the otel bridge", () => {
    const usage = extractUsage({ gen_ai: { usage: { input_tokens: 12, output_tokens: 34 } } });
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 34, cost: undefined });
  });

  it("reads the legacy ai.* shape", () => {
    const usage = extractUsage({ ai: { usage: { promptTokens: 5, completionTokens: 7 } } });
    expect(usage).toEqual({ inputTokens: 5, outputTokens: 7, cost: undefined });
  });

  it("reads a flat tokens/cost pair set by hand", () => {
    const usage = extractUsage({ tokens: { input: 1, output: 2 }, cost: 0.0123 });
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2, cost: 0.0123 });
  });

  it("returns undefined for metadata with no recognizable usage shape", () => {
    expect(extractUsage({ model: "gpt-5.4" })).toBeUndefined();
  });

  it("returns undefined for absent metadata", () => {
    expect(extractUsage(undefined)).toBeUndefined();
  });
});

describe("formatUsage", () => {
  it("formats tokens and cost together", () => {
    expect(formatUsage({ inputTokens: 12, outputTokens: 34, cost: 0.01 })).toBe(
      "tokens: 12 in / 34 out  cost: $0.0100",
    );
  });

  it("formats tokens alone", () => {
    expect(formatUsage({ inputTokens: 12, outputTokens: 34 })).toBe("tokens: 12 in / 34 out");
  });

  it("formats cost alone", () => {
    expect(formatUsage({ cost: 0.5 })).toBe("cost: $0.5000");
  });
});
