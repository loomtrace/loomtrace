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
