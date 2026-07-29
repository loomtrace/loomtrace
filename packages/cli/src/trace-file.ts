import { readFileSync } from "node:fs";

import {
  checkSchemaVersion,
  MIN_READABLE_SCHEMA_VERSION,
  SCHEMA_VERSION,
  type TraceNode,
} from "@loomtrace/core";

export type ReadTraceResult =
  | { readonly ok: true; readonly trace: TraceNode }
  | { readonly ok: false; readonly message: string };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Reads and structurally validates a trace file from disk.
 *
 * Only checks what a reader is actually obliged to check — that the file
 * parses as JSON, that `schemaVersion` is one this build understands, and
 * that `spans` is at least an array. Individual spans are not deeply
 * validated: the schema is additive by design, so a stray or missing
 * optional field is not this function's business to reject.
 */
export function readTraceFile(path: string): ReadTraceResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { ok: false, message: `no such file: ${path}` };
    if (code === "EISDIR") return { ok: false, message: `${path} is a directory, not a file` };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `could not read ${path}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${path} is not valid JSON: ${message}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      message: `${path} does not look like a loomtrace trace (expected a JSON object)`,
    };
  }

  const record = parsed as Record<string, unknown>;
  const compatibility = checkSchemaVersion(record.schemaVersion);
  if (compatibility === "invalid") {
    return {
      ok: false,
      message: `${path} does not look like a loomtrace trace (missing or invalid "schemaVersion")`,
    };
  }
  if (compatibility === "too-new") {
    return {
      ok: false,
      message: `${path} was written by a newer version of loomtrace (schemaVersion ${String(record.schemaVersion)}, this build reads up to ${SCHEMA_VERSION})`,
    };
  }
  if (compatibility === "too-old") {
    return {
      ok: false,
      message: `${path} was written by a version too old to read (schemaVersion ${String(record.schemaVersion)}, minimum readable is ${MIN_READABLE_SCHEMA_VERSION})`,
    };
  }

  if (!Array.isArray(record.spans)) {
    return {
      ok: false,
      message: `${path} does not look like a loomtrace trace (missing "spans" array)`,
    };
  }

  return { ok: true, trace: parsed as TraceNode };
}
