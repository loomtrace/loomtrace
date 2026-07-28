/**
 * @loomtrace/core — public entry point.
 */

export type {
  AbortSignalLike,
  LoomSpan,
  LoomTraceApi,
  LoomTraceConfig,
  RunOptions,
  SpanOptions,
  StepOptions,
} from "./api.js";

export type { DestinationSpec, LoomDestination } from "./destinations/destination.js";

export { LocalDestination } from "./destinations/local-destination.js";
export type { LocalDestinationOptions } from "./destinations/local-destination.js";

export { LoomTrace } from "./loomtrace.js";

export { SilentDestination } from "./destinations/silent-destination.js";

export type {
  JsonValue,
  SpanError,
  SpanNode,
  SpanStatus,
  SpanType,
  Timestamp,
  TraceNode,
} from "./schema.js";

export {
  checkSchemaVersion,
  MIN_READABLE_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from "./version.js";
export type { SchemaCompatibility } from "./version.js";

/** Package name — used in trace metadata and CLI output. */
export const PACKAGE_NAME = "@loomtrace/core" as const;
