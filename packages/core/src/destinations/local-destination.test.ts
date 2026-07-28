import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalDestination } from "./local-destination.js";
import type { TraceNode } from "../schema.js";

function trace(id: string): TraceNode {
  return {
    schemaVersion: 0,
    id,
    name: "example",
    startTime: "2026-07-28T00:00:00.000000000Z",
    endTime: "2026-07-28T00:00:00.100000000Z",
    durationMs: 100,
    status: "ok",
    spans: [
      {
        id: "b".repeat(16),
        parentId: null,
        name: "example",
        type: "run",
        startTime: "2026-07-28T00:00:00.000000000Z",
        endTime: "2026-07-28T00:00:00.100000000Z",
        durationMs: 100,
        status: "ok",
      },
    ],
  };
}

describe("LocalDestination", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loomtrace-local-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the trace to <dir>/<id>.json", async () => {
    const destination = new LocalDestination({ dir });
    const written = trace("a".repeat(32));

    await destination.write(written);

    const raw = await readFile(join(dir, `${written.id}.json`), "utf8");
    expect(JSON.parse(raw)).toEqual(written);
  });

  it("pretty-prints, for a human or the CLI reading the file directly", async () => {
    const destination = new LocalDestination({ dir });
    const written = trace("a".repeat(32));

    await destination.write(written);

    const raw = await readFile(join(dir, `${written.id}.json`), "utf8");
    expect(raw).toContain("\n");
    expect(raw).toMatch(/^\{\n {2}"schemaVersion"/);
  });

  it("creates the directory, including intermediate ones, if it does not exist yet", async () => {
    const nested = join(dir, "does", "not", "exist", "yet");
    const destination = new LocalDestination({ dir: nested });
    const written = trace("a".repeat(32));

    await destination.write(written);

    const raw = await readFile(join(nested, `${written.id}.json`), "utf8");
    expect(JSON.parse(raw)).toEqual(written);
  });

  it("tolerates overlapping writes to the same, not-yet-existing directory", async () => {
    const nested = join(dir, "concurrent");
    const destination = new LocalDestination({ dir: nested });
    const traces = Array.from({ length: 10 }, (_, i) => trace(i.toString(16).padStart(32, "0")));

    await Promise.all(traces.map((t) => destination.write(t)));

    const files = await readdir(nested);
    expect(files).toHaveLength(traces.length);
  });

  it("defaults to .loomtrace/traces under process.cwd()", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);

    try {
      const destination = new LocalDestination();
      const written = trace("a".repeat(32));

      await destination.write(written);

      const raw = await readFile(
        join(dir, ".loomtrace", "traces", `${written.id}.json`),
        "utf8",
      );
      expect(JSON.parse(raw)).toEqual(written);
    } finally {
      cwd.mockRestore();
    }
  });

  it("resolves a relative dir against process.cwd() at construction time", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);

    try {
      const destination = new LocalDestination({ dir: "traces" });
      const written = trace("a".repeat(32));

      await destination.write(written);

      const raw = await readFile(join(dir, "traces", `${written.id}.json`), "utf8");
      expect(JSON.parse(raw)).toEqual(written);
    } finally {
      cwd.mockRestore();
    }
  });
});
