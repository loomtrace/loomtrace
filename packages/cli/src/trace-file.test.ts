import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTraceFile } from "./trace-file.js";
import type { TraceNode } from "@loomtrace/core";

function trace(overrides: Partial<TraceNode> = {}): TraceNode {
  return {
    schemaVersion: 0,
    id: "a".repeat(32),
    name: "example",
    startTime: "2026-07-29T00:00:00.000000000Z",
    status: "ok",
    spans: [],
    ...overrides,
  };
}

describe("readTraceFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loomtrace-cli-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads back a valid trace file", async () => {
    const path = join(dir, "trace.json");
    await writeFile(path, JSON.stringify(trace()));

    const result = readTraceFile(path);

    expect(result.ok).toBe(true);
    expect(result.ok && result.trace.name).toBe("example");
  });

  it("reports a missing file", () => {
    const result = readTraceFile(join(dir, "does-not-exist.json"));
    expect(result).toEqual({ ok: false, message: expect.stringContaining("no such file") });
  });

  it("reports invalid JSON", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{not json");

    const result = readTraceFile(path);

    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("not valid JSON");
  });

  it("reports a JSON value that is not an object", async () => {
    const path = join(dir, "array.json");
    await writeFile(path, "[]");

    const result = readTraceFile(path);

    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("does not look like a loomtrace trace");
  });

  it("reports a missing schemaVersion", async () => {
    const path = join(dir, "no-version.json");
    const { schemaVersion: _schemaVersion, ...rest } = trace();
    await writeFile(path, JSON.stringify(rest));

    const result = readTraceFile(path);

    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain('"schemaVersion"');
  });

  it("reports a schemaVersion newer than this build supports", async () => {
    const path = join(dir, "too-new.json");
    await writeFile(path, JSON.stringify(trace({ schemaVersion: 999 })));

    const result = readTraceFile(path);

    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("newer version of loomtrace");
  });

  it("reports a trace missing the spans array", async () => {
    const path = join(dir, "no-spans.json");
    const { spans: _spans, ...rest } = trace();
    await writeFile(path, JSON.stringify(rest));

    const result = readTraceFile(path);

    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain('"spans"');
  });
});
