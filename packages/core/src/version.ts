/**
 * Versioning policy for the trace JSON schema.
 *
 * The version is a single integer, not a semver string. The reasoning:
 *
 * Every field a reader cares about is either required or optional, and
 * optional fields are detected by presence. So an additive change — a new
 * optional field, a new member of an open union like `SpanType` — carries no
 * information a reader cannot already get by looking. A minor version number
 * would be a second, weaker way of asking a question the data already answers,
 * and the two would eventually disagree.
 *
 * What is left is the one question a reader genuinely cannot answer from the
 * data: "was this written under rules I still understand?" That is a single
 * monotonic counter. Sourcemaps (`version: 3`) and npm lockfiles
 * (`lockfileVersion: 3`) landed in the same place for the same reason.
 *
 * This is deliberately independent of the npm version of `@loomtrace/core`.
 * The package will reach 1.0.0 while the schema is still at 1, and will go on
 * releasing minor versions that do not touch the schema at all.
 */

/**
 * The schema version this build writes.
 *
 * `0` means unstable: no compatibility is promised, and traces written now may
 * become unreadable. It becomes `1` at the first npm release, once the CLI and
 * the OpenTelemetry bridge have actually exercised the schema — those are the
 * two consumers most likely to prove a field wrong, and neither has been
 * written yet.
 */
export const SCHEMA_VERSION = 0;

/**
 * The oldest schema version this build can still read.
 *
 * Raised only when a migration is dropped rather than written. Kept equal to
 * `SCHEMA_VERSION` while the schema is unstable.
 */
export const MIN_READABLE_SCHEMA_VERSION = 0;

/**
 * Whether a trace can be read by this build.
 *
 * `"invalid"` is separate from `"too-old"` on purpose: a file with no usable
 * `schemaVersion` is most likely not a loomtrace trace at all, and telling a
 * user "this is not a trace file" is a different, more useful message than
 * "this trace is too old".
 */
export type SchemaCompatibility = "ok" | "too-new" | "too-old" | "invalid";

/**
 * Classify the `schemaVersion` of a trace read from disk or over the wire.
 *
 * Takes `unknown` rather than `number` because its whole purpose is to be the
 * first thing applied to parsed JSON, before anything has been validated.
 */
export function checkSchemaVersion(version: unknown): SchemaCompatibility {
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 0
  ) {
    return "invalid";
  }
  if (version > SCHEMA_VERSION) return "too-new";
  if (version < MIN_READABLE_SCHEMA_VERSION) return "too-old";
  return "ok";
}

/*
 * ---------------------------------------------------------------------------
 * Policy
 * ---------------------------------------------------------------------------
 *
 * What counts as a breaking change to the schema, and so requires bumping
 * `SCHEMA_VERSION`:
 *
 * - removing or renaming a field
 * - making an optional field required
 * - narrowing a field's type, including removing a member from a closed union
 * - changing the meaning, units, or format of an existing field — this one is
 *   invisible to a typechecker and is the one that will actually be missed
 *
 * What does not require a bump:
 *
 * - adding an optional field
 * - adding a member to an open union (`SpanType`)
 * - widening a field's type
 * - anything in the runtime API that leaves the written JSON unchanged
 *
 * Corresponding obligations on a reader, so that the additive cases really are
 * non-breaking:
 *
 * - ignore unknown fields; never reject a trace for containing one
 * - treat an absent optional field as absent, not as a default value
 * - treat an unrecognized `SpanType` as an opaque label, not an error
 */
