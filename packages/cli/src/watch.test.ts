import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { watchTrace } from "./watch.js";
import type { TraceNode } from "@loomtrace/core";

function trace(name: string): TraceNode {
  return {
    schemaVersion: 0,
    id: "a".repeat(32),
    name,
    startTime: "2026-07-29T00:00:00.000000000Z",
    status: "unset",
    spans: [
      {
        id: "root",
        parentId: null,
        name,
        type: "run",
        startTime: "2026-07-29T00:00:00.000000000Z",
        status: "unset",
      },
    ],
  };
}

/** A fake `watchFile` that a test drives itself instead of waiting on real filesystem events. */
function fakeWatcher(): {
  onChange: () => void;
  watchFile: (path: string, onChange: () => void) => () => void;
  stopped: boolean;
} {
  const watcher = {
    onChange: () => {},
    stopped: false,
    watchFile: (_path: string, onChange: () => void) => {
      watcher.onChange = onChange;
      return () => {
        watcher.stopped = true;
      };
    },
  };
  return watcher;
}

describe("watchTrace", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loomtrace-cli-watch-"));
    path = join(dir, "trace.json");
    await writeFile(path, JSON.stringify(trace("first")));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders one frame immediately, without waiting for a change", () => {
    const frames: string[] = [];
    const watcher = fakeWatcher();

    watchTrace(path, {
      color: false,
      json: false,
      onFrame: (frame) => frames.push(frame),
      watchFile: watcher.watchFile,
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("first");
  });

  it("renders another frame each time the watcher reports a change", async () => {
    const frames: string[] = [];
    const watcher = fakeWatcher();

    watchTrace(path, {
      color: false,
      json: false,
      onFrame: (frame) => frames.push(frame),
      watchFile: watcher.watchFile,
    });

    await writeFile(path, JSON.stringify(trace("second")));
    watcher.onChange();

    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain("second");
  });

  it("renders a fresh JSON frame when json is requested", async () => {
    const frames: string[] = [];
    const watcher = fakeWatcher();

    watchTrace(path, {
      color: false,
      json: true,
      onFrame: (frame) => frames.push(frame),
      watchFile: watcher.watchFile,
    });

    await writeFile(path, JSON.stringify(trace("second")));
    watcher.onChange();

    expect(JSON.parse(frames[1]!)).toMatchObject({ name: "second" });
  });

  it("surfaces a read failure as a frame instead of throwing", () => {
    const frames: string[] = [];
    const watcher = fakeWatcher();

    watchTrace(join(dir, "missing.json"), {
      color: false,
      json: false,
      onFrame: (frame) => frames.push(frame),
      watchFile: watcher.watchFile,
    });

    expect(frames[0]).toContain("no such file");
  });

  it("returns a function that stops the underlying watcher", () => {
    const watcher = fakeWatcher();

    const stop = watchTrace(path, {
      color: false,
      json: false,
      onFrame: () => {},
      watchFile: watcher.watchFile,
    });
    stop();

    expect(watcher.stopped).toBe(true);
  });
});
