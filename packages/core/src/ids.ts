/**
 * Trace and span identifiers.
 *
 * The shapes are OpenTelemetry's — 16 random bytes for a trace, 8 for a span,
 * lowercase hex — so that the bridge in `@loomtrace/otel` can carry OTel ids
 * across unchanged rather than inventing a mapping between two id spaces.
 */

/** 32 zeros: the id of a span that is not being recorded. Matches OTel's invalid id. */
export const INVALID_TRACE_ID = "0".repeat(32);

/** 16 zeros: the id of a span that is not being recorded. Matches OTel's invalid id. */
export const INVALID_SPAN_ID = "0".repeat(16);

const HEX = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  let hex = "";
  for (const byte of bytes) hex += HEX[byte];
  return hex;
}

/** A fresh trace id: 32 lowercase hex characters. */
export function createTraceId(): string {
  return randomHex(16);
}

/** A fresh span id: 16 lowercase hex characters. */
export function createSpanId(): string {
  return randomHex(8);
}
