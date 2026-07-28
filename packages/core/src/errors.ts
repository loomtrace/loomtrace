/**
 * Capturing a failure as data.
 *
 * Item 3.3. This file exists because `catch (error)` in JavaScript catches
 * *anything*: a plain object, a string, `undefined`, a `Symbol`, an object
 * whose `message` is a getter that throws, an `Error` from another realm that
 * fails `instanceof Error`. A tracer that assumes `error.message` is a string
 * turns somebody else's bad throw into its own crash — and it would crash in
 * the one code path that is already on fire.
 *
 * So every read here is defensive, and the whole file is total: `toSpanError`
 * returns a `SpanError` for any input at all and never throws.
 */

import type { SpanError } from "./schema.js";

/**
 * How far a `cause` chain is followed.
 *
 * Wrapped errors are usually two or three deep — a driver error wrapped by a
 * client wrapped by a service. Five is generous; past that, the top of the
 * chain is what anybody debugging is actually reading.
 */
const MAX_CAUSE_DEPTH = 5;

/** How many of an `AggregateError`'s errors are recorded before truncating. */
const MAX_AGGREGATE_ERRORS = 10;

/** `String(value)` for values that may not want to be stringified. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    // A `toString` that throws, or a null-prototype object with no `toString`
    // at all.
    return `<unstringifiable ${typeof value}>`;
  }
}

/** Read a string property, tolerating getters that throw and proxies that trap. */
function readString(source: object, key: string): string | undefined {
  try {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Read any property, tolerating getters that throw and proxies that trap. */
function read(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Whether a value carries the shape of an error, whoever built it.
 *
 * `instanceof Error` is not enough: an error crossing a `vm` context, a worker,
 * or a realm boundary has a different `Error` in its prototype chain and fails
 * the check while being, in every way that matters here, an error. Duck typing
 * is what the platform itself does — `util.inspect` and every serializer of
 * errors ends up here.
 */
function isErrorLike(value: unknown): boolean {
  if (value instanceof Error) return true;
  if (typeof value !== "object" || value === null) return false;
  return (
    readString(value, "message") !== undefined &&
    readString(value, "name") !== undefined
  );
}

/** A label for a thrown object that is not an error: its class, if it has one. */
function objectName(value: object): string {
  try {
    const constructor = (value as { constructor?: { name?: unknown } })
      .constructor;
    const name = constructor?.name;
    return typeof name === "string" && name.length > 0 ? name : "Object";
  } catch {
    return "Object";
  }
}

/**
 * A readable message for a thrown object that is not an error.
 *
 * `String({ code: "rate_limit" })` is `"[object Object]"`, which tells a reader
 * nothing. The JSON form tells them what was thrown, which — since throwing a
 * bare object usually means throwing an API's error payload — is the whole
 * content of the failure.
 */
function describeObject(value: object): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined && json !== "{}") return json;
  } catch {
    // Circular, a BigInt, or a `toJSON` that throws.
  }
  return safeString(value);
}

/**
 * Project any thrown value into the schema's `SpanError`.
 *
 * Follows `cause` chains and `AggregateError.errors`, with a depth cap and a
 * cycle guard: `a.cause = b; b.cause = a` is rare but it does happen, and an
 * infinite loop inside a tracer would be indistinguishable from a hung agent.
 */
export function toSpanError(thrown: unknown): SpanError {
  return capture(thrown, 0, new Set());
}

function capture(thrown: unknown, depth: number, seen: Set<object>): SpanError {
  if (typeof thrown !== "object" || thrown === null) {
    // A thrown primitive: `throw "nope"`, `throw 404`, `throw undefined`. The
    // type is the closest thing to a name it has.
    return { name: typeof thrown, message: safeString(thrown) };
  }

  seen.add(thrown);

  const stack = readString(thrown, "stack");
  const error: SpanError = isErrorLike(thrown)
    ? {
        name: readString(thrown, "name") ?? "Error",
        message: readString(thrown, "message") ?? "",
        ...(stack === undefined ? {} : { stack }),
      }
    : { name: objectName(thrown), message: describeObject(thrown) };

  if (depth >= MAX_CAUSE_DEPTH) return error;

  const cause = read(thrown, "cause");
  if (cause !== undefined && !(typeof cause === "object" && cause !== null && seen.has(cause))) {
    error.cause = capture(cause, depth + 1, seen);
  }

  const errors = read(thrown, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    const kept = errors
      .slice(0, MAX_AGGREGATE_ERRORS)
      .map((each: unknown) => capture(each, depth + 1, seen));

    if (errors.length > MAX_AGGREGATE_ERRORS) {
      kept.push({
        name: "loomtrace",
        message: `${errors.length - MAX_AGGREGATE_ERRORS} further errors were not recorded`,
      });
    }
    error.errors = kept;
  }

  return error;
}

/**
 * Error names that mean "the work was cut short", not "the work was wrong".
 *
 * Matched by name rather than by class, for the reason `isErrorLike` exists: an
 * aborted `fetch` rejects with a `DOMException` in one runtime and with Node's
 * own `AbortError` in another, and neither survives `instanceof` across a realm
 * boundary. Names are what those implementations do agree on.
 *
 * `TimeoutError` is the name `AbortSignal.timeout()` uses, and also the name
 * most timeout helpers give their own error. Both meanings are the one wanted
 * here: a deadline elapsed and the work was abandoned.
 */
const CANCELLATION_NAMES = new Set([
  "AbortError", // `AbortSignal.abort()`, fetch, Node
  "TimeoutError", // `AbortSignal.timeout()`, timeout helpers
  "CanceledError", // axios
  "CancelledError", // the same word, spelled the other way
]);

/**
 * Error codes that mean the same thing.
 *
 * Read as strings only, which conveniently skips `DOMException.code` — a legacy
 * numeric field where `AbortError` is `20`, and not something to match on.
 */
const CANCELLATION_CODES = new Set([
  "ABORT_ERR", // Node's `AbortError`, `fs.promises` with a signal
  "ERR_CANCELED", // axios
]);

/**
 * Whether a thrown value says the work was cancelled rather than broken.
 *
 * The chain is followed because wrapping is what actually happens to an abort
 * on its way up: `new Error("generation failed", { cause: abortError })` is a
 * framework doing its job, and the outermost error has no trace of the abort
 * left in it. Depth and cycles are bounded exactly as in `toSpanError`.
 */
export function isCancellation(thrown: unknown): boolean {
  return detect(thrown, 0, new Set());
}

function detect(thrown: unknown, depth: number, seen: Set<object>): boolean {
  if (typeof thrown !== "object" || thrown === null) return false;
  if (seen.has(thrown)) return false;
  seen.add(thrown);

  const name = readString(thrown, "name");
  if (name !== undefined && CANCELLATION_NAMES.has(name)) return true;

  const code = readString(thrown, "code");
  if (code !== undefined && CANCELLATION_CODES.has(code)) return true;

  if (depth >= MAX_CAUSE_DEPTH) return false;

  if (detect(read(thrown, "cause"), depth + 1, seen)) return true;

  // An `AggregateError` counts only if *every* one of its failures was a
  // cancellation. `Promise.any` across three providers where one was aborted
  // and two returned garbage is a failure, and calling it a cancellation would
  // hide the two that matter.
  //
  // Each element gets its own copy of the path, because the guard above is
  // against cycles, not against seeing the same error twice: `Promise.any([p,
  // p])` over one rejected promise puts one object in the list twice, and the
  // second look must answer the same as the first.
  const errors = read(thrown, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.every((each: unknown) =>
      detect(each, depth + 1, new Set(seen)),
    );
  }

  return false;
}

/**
 * A short description of a value for use in loomtrace's own `onError` messages.
 *
 * Not `SpanError` — this one ends up in a log line, not in a trace.
 */
export function describeCause(error: unknown): string {
  if (typeof error === "object" && error !== null && isErrorLike(error)) {
    return readString(error, "message") ?? safeString(error);
  }
  return safeString(error);
}
