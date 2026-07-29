import { describe, expect, it } from "vitest";

import { renderTrace } from "./render.js";
import type { TraceNode } from "@loomtrace/core";

const trace: TraceNode = {
  schemaVersion: 0,
  id: "a".repeat(32),
  name: "agent run",
  startTime: "2026-07-29T00:00:00.000000000Z",
  endTime: "2026-07-29T00:00:02.500000000Z",
  durationMs: 2500,
  status: "ok",
  spans: [
    {
      id: "root",
      parentId: null,
      name: "agent run",
      type: "run",
      startTime: "2026-07-29T00:00:00.000000000Z",
      endTime: "2026-07-29T00:00:02.500000000Z",
      durationMs: 2500,
      status: "ok",
    },
    {
      id: "c1",
      parentId: "root",
      name: "chat gpt-5.4",
      type: "llm",
      startTime: "2026-07-29T00:00:00.000000000Z",
      endTime: "2026-07-29T00:00:00.300000000Z",
      durationMs: 300,
      status: "ok",
      metadata: { gen_ai: { usage: { input_tokens: 12, output_tokens: 34 } } },
    },
    {
      id: "c2",
      parentId: "root",
      name: "risky tool",
      type: "tool",
      startTime: "2026-07-29T00:00:00.300000000Z",
      endTime: "2026-07-29T00:00:00.350000000Z",
      durationMs: 50,
      status: "error",
      error: { name: "TypeError", message: "boom" },
    },
    {
      id: "c3",
      parentId: "root",
      name: "hung step",
      type: "step",
      startTime: "2026-07-29T00:00:00.350000000Z",
      status: "unset",
    },
  ],
};

describe("renderTrace", () => {
  it("prints the trace header", () => {
    const output = renderTrace(trace, { color: false });
    expect(output).toContain("agent run");
    expect(output).toContain("a".repeat(32));
    expect(output).toContain("status: ✓ ok");
    expect(output).toContain("duration: 2.50s");
  });

  it("draws a tree branch per span, indented under their parent", () => {
    const output = renderTrace(trace, { color: false });
    const lines = output.split("\n");
    expect(lines.some((line) => line.includes("└─") && line.includes("agent run"))).toBe(true);
    expect(lines.some((line) => line.includes("├─") && line.includes("chat gpt-5.4"))).toBe(true);
    expect(lines.some((line) => line.includes("├─") && line.includes("risky tool"))).toBe(true);
    expect(lines.some((line) => line.includes("└─") && line.includes("hung step"))).toBe(true);
  });

  it("shows the error name and message on a failed span", () => {
    const output = renderTrace(trace, { color: false });
    expect(output).toContain("TypeError: boom");
  });

  it("shows token usage extracted from metadata", () => {
    const output = renderTrace(trace, { color: false });
    expect(output).toContain("tokens: 12 in / 34 out");
  });

  it("renders an unset span without a duration", () => {
    const output = renderTrace(trace, { color: false });
    const line = output.split("\n").find((l) => l.includes("hung step"));
    expect(line).toContain("—");
  });

  it("emits no ANSI escapes when color is disabled", () => {
    const output = renderTrace(trace, { color: false });
    expect(output).not.toContain("\x1b[");
  });

  it("emits ANSI escapes when color is enabled", () => {
    const output = renderTrace(trace, { color: true });
    expect(output).toContain("\x1b[");
  });
});
