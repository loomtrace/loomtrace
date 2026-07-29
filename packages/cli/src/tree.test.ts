import { describe, expect, it } from "vitest";

import { buildSpanForest } from "./tree.js";
import type { SpanNode } from "@loomtrace/core";

function span(overrides: Partial<SpanNode> & Pick<SpanNode, "id" | "parentId" | "startTime">): SpanNode {
  return {
    name: overrides.id,
    type: "step",
    status: "ok",
    ...overrides,
  };
}

describe("buildSpanForest", () => {
  it("nests children under their parent", () => {
    const spans = [
      span({ id: "root", parentId: null, startTime: "2026-01-01T00:00:00.000000000Z" }),
      span({ id: "child", parentId: "root", startTime: "2026-01-01T00:00:00.100000000Z" }),
      span({ id: "grandchild", parentId: "child", startTime: "2026-01-01T00:00:00.200000000Z" }),
    ];

    const forest = buildSpanForest(spans);

    expect(forest).toHaveLength(1);
    expect(forest[0]?.span.id).toBe("root");
    expect(forest[0]?.children[0]?.span.id).toBe("child");
    expect(forest[0]?.children[0]?.children[0]?.span.id).toBe("grandchild");
  });

  it("orders siblings by startTime", () => {
    const spans = [
      span({ id: "root", parentId: null, startTime: "2026-01-01T00:00:00.000000000Z" }),
      span({ id: "second", parentId: "root", startTime: "2026-01-01T00:00:00.200000000Z" }),
      span({ id: "first", parentId: "root", startTime: "2026-01-01T00:00:00.100000000Z" }),
    ];

    const forest = buildSpanForest(spans);

    expect(forest[0]?.children.map((c) => c.span.id)).toEqual(["first", "second"]);
  });

  it("treats a span with an unresolvable parentId as a root, not a lost span", () => {
    const spans = [
      span({ id: "orphan", parentId: "does-not-exist", startTime: "2026-01-01T00:00:00.000000000Z" }),
    ];

    const forest = buildSpanForest(spans);

    expect(forest).toHaveLength(1);
    expect(forest[0]?.span.id).toBe("orphan");
  });

  it("returns an empty forest for no spans", () => {
    expect(buildSpanForest([])).toEqual([]);
  });
});
