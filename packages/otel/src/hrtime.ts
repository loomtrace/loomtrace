/**
 * Bridging OpenTelemetry's `HrTime` to core's timestamp format.
 *
 * `HrTime` is `[seconds, nanoseconds]` since the Unix epoch (two `number`s);
 * core's `Timestamp` is the same instant as nine-fractional-digit ISO 8601
 * text, chosen specifically so this conversion is lossless in both
 * directions. The actual formatting logic lives once, in `@loomtrace/core`'s
 * `clock.ts`; this file only turns an `HrTime` pair into the `EpochNanos`
 * bigint that function expects.
 */

import type { HrTime } from "@opentelemetry/api";
import { durationMs as epochDurationMs, formatTimestamp, type EpochNanos, type Timestamp } from "@loomtrace/core";

const NANOS_PER_SECOND = 1_000_000_000n;

/** `[seconds, nanoseconds]` → nanoseconds since the epoch. */
export function hrTimeToEpochNanos([seconds, nanos]: HrTime): EpochNanos {
  return BigInt(seconds) * NANOS_PER_SECOND + BigInt(nanos);
}

/** An `HrTime` as a loomtrace `Timestamp`. */
export function hrTimeToTimestamp(hrTime: HrTime): Timestamp {
  return formatTimestamp(hrTimeToEpochNanos(hrTime));
}

/** Elapsed milliseconds between two `HrTime`s, fractional. */
export function hrTimeDurationMs(start: HrTime, end: HrTime): number {
  return epochDurationMs(hrTimeToEpochNanos(start), hrTimeToEpochNanos(end));
}
