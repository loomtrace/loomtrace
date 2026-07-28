/**
 * Time, in the two forms a trace needs it.
 *
 * A span records both *when* it happened (a wall-clock `Timestamp`, so a reader
 * can line it up against logs) and *how long* it took (`durationMs`). Those are
 * different questions, and taking both from `Date.now()` answers neither well:
 * it has millisecond resolution, which rounds a fast step to `0`, and it can
 * jump backwards when the system clock is corrected mid-run, which produces
 * negative durations.
 *
 * So everything here is derived from `performance`: `timeOrigin` fixes the
 * epoch once, and `performance.now()` — monotonic, sub-microsecond — advances
 * from it. Both answers then come from one monotonic source.
 */

import type { Timestamp } from "./schema.js";

const NANOS_PER_MS = 1_000_000n;

/**
 * A point in time as nanoseconds since the Unix epoch.
 *
 * `bigint` rather than `number` because the epoch in nanoseconds is around
 * `1.75e18`, well past the `2**53` where a double stops counting by ones.
 */
export type EpochNanos = bigint;

/**
 * The process's `performance` epoch, in nanoseconds, computed once.
 *
 * Split into whole and fractional milliseconds before widening: `timeOrigin` is
 * a float of about `1.75e12`, and multiplying it by `1e6` first would land in
 * the range where doubles no longer represent every integer.
 */
const ORIGIN_NANOS: EpochNanos = (() => {
  const origin = performance.timeOrigin;
  const wholeMs = Math.trunc(origin);
  const fracMs = origin - wholeMs;
  return BigInt(wholeMs) * NANOS_PER_MS + BigInt(Math.round(fracMs * 1e6));
})();

/**
 * The current instant, in nanoseconds since the epoch.
 *
 * Monotonic within a process: `performance.now()` is unaffected by system clock
 * adjustments, so a span's end can never precede its start.
 *
 * The nanosecond digits stay exact for roughly the first hundred days of
 * process uptime, after which `performance.now() * 1e6` exceeds `2**53` and the
 * last digits drift. A trace timed to the microsecond after three months of
 * uptime is not a use case worth a slower clock.
 */
export function now(): EpochNanos {
  return ORIGIN_NANOS + BigInt(Math.round(performance.now() * 1e6));
}

/**
 * Render an instant as the schema's timestamp format: ISO 8601, UTC, with
 * exactly nine fractional digits.
 *
 * `Date` supplies the calendar part only, from a whole number of milliseconds.
 * The sub-millisecond digits are appended as text and never pass through
 * `Date`, which would truncate them — see `Timestamp` in `schema.ts`.
 */
export function formatTimestamp(nanos: EpochNanos): Timestamp {
  const millis = nanos / NANOS_PER_MS;
  const subMillisNanos = nanos % NANOS_PER_MS;
  const iso = new Date(Number(millis)).toISOString();

  // `toISOString()` ends in `.mmmZ`; drop the `Z`, append the remaining six
  // digits, put it back.
  return `${iso.slice(0, -1)}${String(subMillisNanos).padStart(6, "0")}Z`;
}

/**
 * Elapsed milliseconds between two instants, fractional.
 *
 * The difference is at most a process's uptime in nanoseconds, so narrowing to
 * `number` here is safe — unlike narrowing an absolute epoch value.
 */
export function durationMs(start: EpochNanos, end: EpochNanos): number {
  return Number(end - start) / 1e6;
}
