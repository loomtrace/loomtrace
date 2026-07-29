import type { SpanNode } from "@loomtrace/core";

export interface SpanTreeNode {
  readonly span: SpanNode;
  readonly children: SpanTreeNode[];
}

/**
 * Groups a flat `spans` list into a forest of `SpanTreeNode`s.
 *
 * Spans are stored flat with `parentId` — normally there is exactly one root
 * (`parentId: null`), but a span whose `parentId` points at an id that is not
 * in the list (a partially flushed trace, a hand-built one) is treated as a
 * root too, rather than dropped, so the rest of the trace stays readable.
 *
 * Siblings are ordered by `startTime`, which sorts chronologically as a plain
 * string because the schema fixes the timestamp format's digit count.
 */
export function buildSpanForest(spans: readonly SpanNode[]): SpanTreeNode[] {
  const knownIds = new Set(spans.map((span) => span.id));
  const childrenByParent = new Map<string, SpanNode[]>();
  const roots: SpanNode[] = [];

  for (const span of spans) {
    if (span.parentId !== null && knownIds.has(span.parentId)) {
      const siblings = childrenByParent.get(span.parentId);
      if (siblings) siblings.push(span);
      else childrenByParent.set(span.parentId, [span]);
    } else {
      roots.push(span);
    }
  }

  const byStartTime = (a: SpanNode, b: SpanNode): number =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;

  const toNode = (span: SpanNode): SpanTreeNode => ({
    span,
    children: (childrenByParent.get(span.id) ?? []).sort(byStartTime).map(toNode),
  });

  return roots.sort(byStartTime).map(toNode);
}
