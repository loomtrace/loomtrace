/**
/**
 * Trace JSON schema — the public contract of loomtrace.
 *
 * This file is types only, by design: it describes the shape of a trace on
 * disk and on the wire, independent of how it was produced. Anything written
 * to a `.loomtrace/traces/<id>.json` file must satisfy `TraceNode`, and any
 * reader (CLI, future dashboard, third-party tooling) may rely on it.
 *
 * Changing these types is a breaking change for every consumer — see the
 * versioning policy in `version.ts` and `DESIGN.md`, section 3.
 */

/**
 * Any value that survives a `JSON.stringify` / `JSON.parse` round-trip.
 *
 * Used for everything a caller hands us (`input`, `output`, `metadata`) so the
 * schema stays a contract rather than a suggestion. Values that do not fit —
 * class instances, functions, circular references — are the caller's problem to
 * project into JSON, or ours to serialize defensively at the destination
 * boundary.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * An instant in time, as an RFC 3339 / ISO 8601 UTC timestamp with exactly
 * nine fractional digits: `2026-07-28T11:22:33.123456789Z`.
 *
 * Nine digits rather than the three that `Date.prototype.toISOString()`
 * produces, for two reasons:
 *
 * 1. OpenTelemetry timestamps are nanosecond-precision (`HrTime` internally,
 *    `startTimeUnixNano` on the wire). Nine digits make the bridge in
 *    `@loomtrace/otel` lossless in both directions.
 * 2. A fixed digit count means lexicographic string ordering equals
 *    chronological ordering, so readers can sort spans without parsing.
 *
 * Beware: `new Date(iso)` parses these fine but truncates to milliseconds, so
 * `new Date(iso).toISOString()` silently discards digits 4-9. Format these
 * strings directly; never round-trip a timestamp through `Date`.
 */
export type Timestamp = string;

/**
 * Terminal state of a span or trace.
 *
 * `"unset"` covers spans that were started but never closed — a crashed
 * process, a killed container — and is what a reader will see for the tail of
 * a partially flushed trace. It is not an error, it is an absence of an
 * answer, and the CLI renders it differently from both.
 */
export type SpanStatus = "ok" | "error" | "unset";

/**
 * What kind of work a span represents.
 *
 * Deliberately an open union: the listed values get autocompletion and cover
 * what loomtrace itself emits, while a framework embedding us can use its own
 * vocabulary without patching this file. LangSmith shipped a closed union here
 * and later deprecated it in favour of a raw string; this is that lesson,
 * applied up front.
 */
export type SpanType =
  | "run"
  | "step"
  | "llm"
  | "tool"
  | "retrieval"
  | (string & {});

/**
 * A failure captured on a span.
 *
 * Structured rather than a bare message string, so the CLI can show a one-line
 * summary and keep the stack for `--verbose`. The thrown value is not stored:
 * it is arbitrary JS and often not serializable.
 */
export interface SpanError {
  /** Constructor name of the thrown value, e.g. `"TypeError"`. */
  name: string;
  /** Human-readable message. */
  message: string;
  /** Stack trace, when the thrown value carried one. */
  stack?: string;
  /**
   * The error this one wrapped — `new Error(msg, { cause })` — recorded
   * recursively, a few levels deep.
   *
   * The outermost error of a chain is almost never the one that explains the
   * failure: "generation failed" wraps "request failed" wraps "ECONNREFUSED",
   * and only the last of those is actionable.
   */
  cause?: SpanError;
  /**
   * The individual failures of an `AggregateError`, as produced by
   * `Promise.any` — a retry across several providers, most often.
   *
   * Without this, such a span records only "All promises were rejected", which
   * says that everything failed but nothing about why.
   */
  errors?: SpanError[];
}

/**
 * A single unit of work within a trace.
 *
 * Spans are stored flat, with parentage expressed by `parentId` rather than by
 * nesting. This is what OpenTelemetry, Langfuse and LangSmith all converge on,
 * and it is what makes a trace robust: spans can be appended as they close, in
 * any order, and a span whose parent is missing or unclosed is still readable.
 * Building the tree is the reader's job.
 */
export interface SpanNode {
  /** Unique within the trace. 16 lowercase hex characters, matching OTel span ids. */
  id: string;
  /** Parent span's `id`, or `null` for the trace's root span. */
  parentId: string | null;
  /** Human-readable label, as passed to `.run()` / `.step()`. */
  name: string;
  /** What kind of work this span represents. */
  type: SpanType;
  /** When the work started. */
  startTime: Timestamp;
  /** When the work finished. Absent means the span never closed. */
  endTime?: Timestamp;
  /**
   * Wall-clock duration in milliseconds, fractional.
   *
   * Redundant with `startTime`/`endTime`, and denormalized on purpose: the CLI
   * sorts and colours by duration on every render, and sub-millisecond steps
   * should not all collapse to `0`.
   */
  durationMs?: number;
  /** Terminal state of the work. */
  status: SpanStatus;
  /** What the step was called with. */
  input?: JsonValue;
  /** What the step returned. Absent when it threw. */
  output?: JsonValue;
  /** Present iff `status` is `"error"`. */
  error?: SpanError;
  /**
   * Set when the work was cut short from outside — an `AbortSignal` fired, a
   * deadline elapsed — rather than failing on its own terms.
   *
   * Only ever `true`, and only alongside `status: "error"`. Absent means "not
   * cancelled", so there is exactly one way to say it and the flag costs
   * nothing on the spans that do not need it.
   *
   * A cancellation is still a failure: the work did not produce its result, and
   * the error that carried it is recorded like any other. It is a different
   * *kind* of failure from a bug, though — an agent that abandons a slow tool
   * call after two seconds and retries with another is working correctly — so a
   * reader counting real breakages wants `status === "error" && !cancelled`.
   */
  cancelled?: true;
  /**
   * Arbitrary caller-supplied annotations: model name, token counts, cost,
   * retry attempt, whatever the embedding framework finds worth recording.
   *
   * Nested objects are allowed and preserved — unlike OTel attributes, which
   * are flat and force conventions like `langfuse.metadata.db.host`. We write
   * JSON files, so that constraint is not ours to inherit.
   */
  metadata?: Record<string, JsonValue>;
}

/**
 * One complete execution — the root of a trace file.
 *
 * A trace is a header plus a flat list of spans. Exactly one span in `spans`
 * has `parentId: null`; every other `parentId` refers to an `id` in the same
 * list.
 */
export interface TraceNode {
  /**
   * Version of this schema — a single integer, see `SCHEMA_VERSION` and the
   * policy in `version.ts`.
   *
   * Typed as `number` rather than as the literal this build writes, so that a
   * reader can load a trace produced by a different version of loomtrace and
   * decide what to do about it via `checkSchemaVersion()`, instead of failing
   * to typecheck on the file it is supposed to be diagnosing.
   */
  schemaVersion: number;
  /** Unique identifier for this execution. 32 lowercase hex characters, matching OTel trace ids. */
  id: string;
  /** Human-readable label, as passed to `.run()`. */
  name: string;
  /** When the run started. Matches the root span's `startTime`. */
  startTime: Timestamp;
  /** When the run finished. Absent means the process died mid-run. */
  endTime?: Timestamp;
  /** Wall-clock duration of the whole run, in fractional milliseconds. */
  durationMs?: number;
  /** Terminal state of the run as a whole. */
  status: SpanStatus;
  /**
   * Set when the run itself was cancelled — mirrors the root span's
   * `cancelled`, the way `status` and `durationMs` mirror its.
   */
  cancelled?: true;
  /** Every span in the run, flat and unordered. */
  spans: SpanNode[];
  /** Run-level annotations: environment, release, session id, user id. */
  metadata?: Record<string, JsonValue>;
}
