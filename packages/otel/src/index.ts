/**
 * @loomtrace/otel — bridge between OpenTelemetry and the loomtrace trace format.
 */

import { SCHEMA_VERSION } from "@loomtrace/core";

/** Schema version this bridge converts OTel spans into. */
export const TARGET_SCHEMA_VERSION = SCHEMA_VERSION;

export { LoomTraceSpanProcessor } from "./span-processor.js";
export type { LoomTraceSpanProcessorOptions } from "./span-processor.js";
