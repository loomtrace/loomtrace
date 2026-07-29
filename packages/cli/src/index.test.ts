import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "./index.js";
import type { TraceNode } from "@loomtrace/core";

describe("@loomtrace/cli", () => {
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

  describe("inspect", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "loomtrace-cli-inspect-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("fails when <path> is missing", () => {
      const result = run(["inspect"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("missing <path>");
    });

    it("fails on a nonexistent file", () => {
      const result = run(["inspect", join(dir, "missing.json")]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("no such file");
    });

    it("renders a valid trace file", async () => {
      const trace: TraceNode = {
        schemaVersion: 0,
        id: "b".repeat(32),
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
      const path = join(dir, "trace.json");
      await writeFile(path, JSON.stringify(trace));

      const result = run(["inspect", path]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("my agent");
      expect(result.stdout).toContain("b".repeat(32));
    });

    it("does not emit ANSI escapes unless color is explicitly enabled", async () => {
      const trace: TraceNode = {
        schemaVersion: 0,
        id: "c".repeat(32),
        name: "plain",
        startTime: "2026-07-29T00:00:00.000000000Z",
        status: "ok",
        spans: [],
      };
      const path = join(dir, "plain.json");
      await writeFile(path, JSON.stringify(trace));

      const result = run(["inspect", path]);

      expect(result.stdout).not.toContain("\x1b[");
    });
  });
});
