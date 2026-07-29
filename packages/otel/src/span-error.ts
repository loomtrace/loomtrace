/**
 * Building the `SpanError` a `status: "error"` `SpanNode` requires (core
 * `schema.ts`: "Present iff `status` is `"error"`").
 *
 * OTel has no structured-error field on a span; the convention is
 * `Span.recordException()`, which appends a `TimedEvent` named `"exception"`
 * carrying `exception.type` / `exception.message` / `exception.stacktrace`
 * attributes. That is the source of truth here. A span can also be marked
 * `status: { code: ERROR, message }` without ever recording an exception —
 * `span.setStatus(...)` alone — so the status message is the fallback, not
 * an afterthought.
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { SpanError } from "@loomtrace/core";

const EXCEPTION_EVENT_NAME = "exception";

function readStringAttribute(
  attributes: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Build the error for an ended span whose `status.code` is `ERROR`.
 *
 * A span can `recordException()` more than once — a retry loop that caught
 * and logged earlier attempts before the one that actually failed the span —
 * so the *last* exception event is taken as the one that explains the
 * outcome, not the first.
 */
export function spanErrorFromEvents(span: ReadableSpan): SpanError {
  const exceptionEvent = [...span.events]
    .reverse()
    .find((event) => event.name === EXCEPTION_EVENT_NAME);

  const attrs = exceptionEvent?.attributes as Record<string, unknown> | undefined;

  const name = readStringAttribute(attrs, "exception.type") ?? "Error";
  const message =
    readStringAttribute(attrs, "exception.message") ?? span.status.message ?? "";
  const stack = readStringAttribute(attrs, "exception.stacktrace");

  return stack === undefined ? { name, message } : { name, message, stack };
}
