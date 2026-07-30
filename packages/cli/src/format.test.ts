import { describe, expect, it } from "vitest";

import { formatInspection } from "./format.js";
import type { ReadTraceResult } from "./trace-file.js";
import type { TraceNode } from "@loomtrace/core";

const trace: TraceNode = {
  schemaVersion: 0,
  id: "a".repeat(32),
  name: "my agent",
  startTime: "2026-07-29T00:00:00.000000000Z",
  endTime: "2026-07-29T00:00:00.500000000Z",
  durationMs: 500,
  status: "ok",
  spans: [
    {
      id: "root",
      parentId: null,
      name: "my agent",
      type: "run",
      startTime: "2026-07-29T00:00:00.000000000Z",
      endTime: "2026-07-29T00:00:00.500000000Z",
      durationMs: 500,
      status: "ok",
    },
  ],
};

const ok: ReadTraceResult = { ok: true, trace };
const failed: ReadTraceResult = { ok: false, message: "no such file: missing.json" };

describe("formatInspection", () => {
  it("renders the ASCII tree for a successful read", () => {
    const text = formatInspection(ok, false, { color: false });
    expect(text).toContain("my agent");
    expect(text).toContain("└─");
  });

  it("renders raw JSON when json is requested", () => {
    const text = formatInspection(ok, true, { color: false });
    expect(JSON.parse(text)).toEqual(trace);
  });

  it("formats a failed read as the one-line error inspect() prints, regardless of json", () => {
    expect(formatInspection(failed, false, { color: false })).toBe(
      "loomtrace inspect: no such file: missing.json\n",
    );
    expect(formatInspection(failed, true, { color: false })).toBe(
      "loomtrace inspect: no such file: missing.json\n",
    );
  });
});
