/**
 * Converting one OTel span into loomtrace's `SpanNode`: ids, timing,
 * status, a generic un-flattened `metadata` for whatever attributes are
 * present, plus a `type`/`input`/`output` refinement for the two attribute
 * conventions Vercel AI SDK's OTel bridge emits. Any span that matches
 * neither convention still gets the structural mapping — recognizing
 * `gen_ai.*`/`ai.*` is additive, not required.
 */

import { SpanStatusCode } from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { SpanNode, SpanStatus, SpanType } from "@loomtrace/core";

import { refineFromAiSdkAttributes } from "./ai-sdk.js";
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

/** `type` for a span neither structural position nor attribute convention refines. */
function defaultSpanType(parentId: string | null): SpanType {
  return parentId === null ? "run" : "step";
}

/** `attributes` with the keys a refinement already turned into `input`/`output` removed. */
function withoutConsumedKeys(attributes: Attributes, consumedKeys: readonly string[]): Attributes {
  if (consumedKeys.length === 0) return attributes;
  const remaining = { ...attributes };
  for (const key of consumedKeys) delete remaining[key];
  return remaining;
}

/**
 * Convert an ended span (`SpanProcessor.onEnd`) into a complete `SpanNode`.
 */
export function toSpanNode(span: ReadableSpan): SpanNode {
  const parentId = readParentSpanId(span);
  const status = STATUS_BY_CODE[span.status.code];
  const refinement = refineFromAiSdkAttributes(span.attributes);

  const node: SpanNode = {
    id: span.spanContext().spanId,
    parentId,
    name: span.name,
    type: refinement?.type ?? defaultSpanType(parentId),
    startTime: hrTimeToTimestamp(span.startTime),
    endTime: hrTimeToTimestamp(span.endTime),
    durationMs: hrTimeDurationMs(span.startTime, span.endTime),
    status,
  };

  if (refinement?.input !== undefined) node.input = refinement.input;
  if (refinement?.output !== undefined) node.output = refinement.output;

  const remainingAttributes = withoutConsumedKeys(span.attributes, refinement?.consumedKeys ?? []);
  const metadata = attributesToMetadata(remainingAttributes);
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
  const type = refineFromAiSdkAttributes(span.attributes)?.type ?? defaultSpanType(parentId);
  return {
    id: span.spanContext().spanId,
    parentId,
    name: span.name,
    type,
    startTime: hrTimeToTimestamp(span.startTime),
    status: "unset",
  };
}
