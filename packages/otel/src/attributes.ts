/**
 * OTel `Attributes` are flat and dot-namespaced (`gen_ai.usage.input_tokens`,
 * `ai.response.finishReason`) because attribute keys have no nesting of their
 * own. loomtrace's `metadata` nests freely — OTel's flatness forces
 * conventions like `langfuse.metadata.db.host`, and a JSON trace file has no
 * reason to inherit that constraint. This un-flattens one into the other.
 *
 * This is the generic, format-agnostic half of the mapping. Recognizing
 * *which* dotted keys mean "this is the prompt" or "this is the model id" is
 * a separate, AI-SDK-specific refinement; this file only makes sure no
 * attribute is lost between the two shapes.
 */

import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { JsonValue } from "@loomtrace/core";

/** An OTel attribute value is already JSON-shaped, except `undefined` array entries. */
function toJsonValue(value: AttributeValue): JsonValue {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => entry ?? null);
}

function isPlainObject(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Place one `key.split(".")` path into a nested object tree, in place.
 *
 * Returns `false` if the path collides with a value already set by another
 * attribute — `"a"` and `"a.b"` both present, which is not a shape any real
 * instrumentation produces but is not this bridge's to assume about
 * arbitrary third-party attributes either. The caller falls back to the flat
 * key rather than this function throwing or silently dropping data.
 */
function setNested(
  root: Record<string, JsonValue>,
  parts: readonly string[],
  value: JsonValue,
): boolean {
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    const existing = node[part];
    if (existing === undefined) {
      const next: Record<string, JsonValue> = {};
      node[part] = next;
      node = next;
    } else if (isPlainObject(existing)) {
      node = existing;
    } else {
      return false;
    }
  }
  const last = parts[parts.length - 1] as string;
  if (isPlainObject(node[last])) return false; // a deeper key already claimed this as a namespace
  node[last] = value;
  return true;
}

/**
 * Un-flatten an OTel `attributes` bag into loomtrace `metadata`.
 *
 * Returns `undefined` for an empty bag, matching `SpanNode.metadata` being
 * absent rather than `{}` when there is nothing to say.
 */
export function attributesToMetadata(
  attributes: Attributes,
): Record<string, JsonValue> | undefined {
  const root: Record<string, JsonValue> = {};
  let any = false;

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    any = true;
    const json = toJsonValue(value);
    if (!setNested(root, key.split("."), json)) {
      root[key] = json;
    }
  }

  return any ? root : undefined;
}
