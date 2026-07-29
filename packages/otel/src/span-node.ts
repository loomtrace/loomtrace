/**
 * Converting one OTel span into loomtrace's `SpanNode` — the structural,
 * format-agnostic half of the mapping (ids, timing, status, a generic
 * un-flattened `metadata`). Recognizing Vercel AI SDK's `gen_ai.*`/`ai.*`
 * conventions specifically — refining `type`, pulling `input`/`output` out
 * of attributes — is a separate, later refinement; nothing here reads an
 * attribute key by name.
 */

import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { SpanNode, SpanStatus, SpanType } from "@loomtrace/core";

import { attributesToMetadata } from "./attributes.js";
import { hrTimeDurationMs, hrTimeToTimestamp } from "./hrtime.js";
import { spanErrorFromEvents } from "./span-error.js";

const STATUS_BY_CODE: Record<SpanStatusCode, SpanStatus> = {
  [SpanStatusCode.UNSET]: "unset",
  [SpanStatusCode.OK]: "ok",
  [SpanStatusCode.ERROR]: "error",
};

/**
 * The parent span's id, or `null` for a root span.
 *
 * Bridges a real breaking change, not a hypothetical one — verified against
 * both lines: `@opentelemetry/sdk-trace-base@1.x` exposes
 * `parentSpanId?: string`, `2.x` replaced it with `parentSpanContext?:
 * SpanContext`. This package builds against whichever major happens to be
 * installed as a dev dependency, but the *host application's* installed
 * version is not this package's to control, so both shapes are read
 * structurally rather than trusting the compile-time type. Reading a
 * property that a given span object simply does not have returns `undefined`
 * either way, so a root span on either version falls through both checks to
 * `null` correctly.
 */
function readParentSpanId(span: ReadableSpan): string | null {
  const modern = (span as { parentSpanContext?: { spanId: string } })
    .parentSpanContext;
  if (modern !== undefined) return modern.spanId;

  const legacy = (span as unknown as { parentSpanId?: string }).parentSpanId;
  return legacy ?? null;
}

/** `type` for a span this bridge has no richer classification for yet. */
function defaultSpanType(parentId: string | null): SpanType {
  return parentId === null ? "run" : "step";
}

/**
 * Convert an ended span (`SpanProcessor.onEnd`) into a complete `SpanNode`.
 */
export function toSpanNode(span: ReadableSpan): SpanNode {
  const parentId = readParentSpanId(span);
  const status = STATUS_BY_CODE[span.status.code];

  const node: SpanNode = {
    id: span.spanContext().spanId,
    parentId,
    name: span.name,
    type: defaultSpanType(parentId),
    startTime: hrTimeToTimestamp(span.startTime),
    endTime: hrTimeToTimestamp(span.endTime),
    durationMs: hrTimeDurationMs(span.startTime, span.endTime),
    status,
  };

  const metadata = attributesToMetadata(span.attributes);
  if (metadata !== undefined) node.metadata = metadata;
  if (status === "error") node.error = spanErrorFromEvents(span);

  return node;
}

/**
 * The placeholder recorded at `onStart`, used only if this span never
 * reaches `onEnd` before its trace is sealed — a child whose own `.end()`
 * was never called, the same "unset" case core's own `AsyncLocalStorage`
 * path produces for a span that never closes.
 *
 * Takes the same structural fields `onStart` can actually see; `Span`
 * (the mutable handle) is a strict superset of `ReadableSpan`'s readable
 * fields, so this accepts either.
 */
export function toPendingSpanNode(span: ReadableSpan): SpanNode {
  const parentId = readParentSpanId(span);
  return {
    id: span.spanContext().spanId,
    parentId,
    name: span.name,
    type: defaultSpanType(parentId),
    startTime: hrTimeToTimestamp(span.startTime),
    status: "unset",
  };
}
