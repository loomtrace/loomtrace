/**
 * @loomtrace/otel — bridge between OpenTelemetry and the loomtrace trace format.
 */

import { SCHEMA_VERSION } from "@loomtrace/core";

/** Schema version this bridge converts OTel spans into. */
export const TARGET_SCHEMA_VERSION = SCHEMA_VERSION;
