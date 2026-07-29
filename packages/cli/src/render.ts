import type { SpanNode, SpanStatus, TraceNode } from "@loomtrace/core";

import { bold, dim, paint } from "./color.js";
import { extractUsage, formatUsage } from "./usage.js";
import { buildSpanForest, type SpanTreeNode } from "./tree.js";

/**
 * Latency bands for coloring a span's duration, in milliseconds.
 *
 * Picked for agent workloads, where an LLM call routinely takes hundreds of
 * milliseconds to a couple of seconds and a plain tool call is much faster:
 * under a second reads as normal, a few seconds as worth a look, longer than
 * that as the thing to investigate first. Not configurable yet — a real
 * threshold needs tuning against actual traces, not a guess.
 */
const LATENCY_YELLOW_MS = 1_000;
const LATENCY_RED_MS = 5_000;

function formatDuration(durationMs: number): string {
  if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(2)}s`;
  return `${Math.round(durationMs)}ms`;
}

function colorizeDuration(durationMs: number | undefined, color: boolean): string {
  if (durationMs === undefined) return dim("—", color);
  const text = formatDuration(durationMs);
  if (durationMs >= LATENCY_RED_MS) return paint(text, "red", color);
  if (durationMs >= LATENCY_YELLOW_MS) return paint(text, "yellow", color);
  return paint(text, "green", color);
}

function statusIcon(status: SpanStatus, color: boolean): string {
  switch (status) {
    case "ok":
      return paint("✓", "green", color);
    case "error":
      return paint("✗", "red", color);
    case "unset":
      return dim("…", color);
  }
}

function renderSpanLabel(span: SpanNode, color: boolean): string {
  const parts = [
    statusIcon(span.status, color),
    span.name,
    dim(`(${span.type})`, color),
    colorizeDuration(span.durationMs, color),
  ];

  const usage = extractUsage(span.metadata);
  if (usage) parts.push(dim(formatUsage(usage), color));

  if (span.status === "error" && span.error) {
    const cancelledSuffix = span.cancelled ? " (cancelled)" : "";
    parts.push(paint(`— ${span.error.name}: ${span.error.message}${cancelledSuffix}`, "red", color));
  }

  return parts.join(" ");
}

function renderForest(forest: readonly SpanTreeNode[], color: boolean): string[] {
  const lines: string[] = [];

  const walk = (node: SpanTreeNode, prefix: string, isLast: boolean): void => {
    const branch = prefix + (isLast ? "└─ " : "├─ ");
    lines.push(branch + renderSpanLabel(node.span, color));
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    node.children.forEach((child, index) => {
      walk(child, childPrefix, index === node.children.length - 1);
    });
  };

  forest.forEach((root, index) => walk(root, "", index === forest.length - 1));
  return lines;
}

function renderHeader(trace: TraceNode, color: boolean): string[] {
  return [
    `${bold(trace.name, color)}  ${dim(trace.id, color)}`,
    [
      `status: ${statusIcon(trace.status, color)} ${trace.status}${trace.cancelled ? " (cancelled)" : ""}`,
      `duration: ${colorizeDuration(trace.durationMs, color)}`,
      `started: ${dim(trace.startTime, color)}`,
    ].join("   "),
    "",
  ];
}

/** Renders a full trace — header plus the span tree — as one string. */
export function renderTrace(trace: TraceNode, options: { readonly color: boolean }): string {
  const forest = buildSpanForest(trace.spans);
  const lines = [...renderHeader(trace, options.color), ...renderForest(forest, options.color)];
  return lines.join("\n") + "\n";
}
