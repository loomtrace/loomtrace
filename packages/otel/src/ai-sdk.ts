/**
 * Recognizing the two attribute conventions Vercel AI SDK's OTel bridge
 * emits — `gen_ai.*` (current, OTel GenAI semantic conventions) and `ai.*`
 * (legacy, opt-in) — to refine a span beyond what generic attribute
 * un-flattening can know on its own: whether it represents a model call or a
 * tool call, and what its `input`/`output` actually were.
 *
 * Nothing here assumes either convention is present. A span with neither
 * (someone's own manual instrumentation, or any other OTel producer) simply
 * gets no refinement, and falls back to the generic mapping.
 */

import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { JsonValue, SpanType } from "@loomtrace/core";

import { toJsonValue } from "./attributes.js";

/**
 * `gen_ai.operation.name` values this bridge can classify. `"invoke_agent"`
 * is deliberately absent: it does not mean "a nested agent run" the way
 * loomtrace uses that idea elsewhere — it is the outer span of an AI-SDK
 * call that may itself contain model calls and tool calls, so the ordinary
 * root/child default (a span with no locally-visible parent is a run,
 * everything else is a step) already describes it correctly without help
 * from this table.
 */
const GEN_AI_OPERATION_TYPE: Readonly<Partial<Record<string, SpanType>>> = {
  chat: "llm",
  embeddings: "llm",
  rerank: "llm",
  execute_tool: "tool",
};

const GEN_AI_INPUT_KEYS = ["gen_ai.tool.call.arguments", "gen_ai.input.messages"] as const;
const GEN_AI_OUTPUT_KEYS = ["gen_ai.tool.call.result", "gen_ai.output.messages"] as const;

const LEGACY_TOOL_OPERATION_ID = "ai.toolCall";
const LEGACY_INPUT_KEYS = ["ai.toolCall.args", "ai.prompt.messages", "ai.prompt"] as const;
const LEGACY_OUTPUT_KEYS = ["ai.toolCall.result", "ai.response.object", "ai.response.text"] as const;
/** Plain output text, not a JSON-encoded payload like its sibling keys — never `JSON.parse`d. */
const LEGACY_PLAIN_TEXT_KEY = "ai.response.text";

export interface AiSdkRefinement {
  /** Overrides the structural default, when this convention says more. */
  type?: SpanType;
  input?: JsonValue;
  output?: JsonValue;
  /**
   * Attribute keys this refinement already surfaced as `input`/`output` —
   * the caller should leave these out of the generic un-flattened
   * `metadata`, or a multi-megabyte message array ends up stored twice.
   */
  consumedKeys: readonly string[];
}

type Resolver = (key: string, value: AttributeValue) => JsonValue;

/**
 * Most of these attributes are JSON-stringified by the AI SDK (an OTel
 * attribute can only be a primitive or a homogeneous array, never a nested
 * object, so a message array or a tool result has nowhere else to go).
 * Parse it back into structured JSON; if it does not parse — a
 * differently-behaved producer, a future SDK version — fall back to the raw
 * string rather than losing it.
 */
function resolveJsonAttribute(_key: string, value: AttributeValue): JsonValue {
  if (typeof value !== "string") return toJsonValue(value);
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function resolveLegacyAttribute(key: string, value: AttributeValue): JsonValue {
  if (key === LEGACY_PLAIN_TEXT_KEY) {
    return typeof value === "string" ? value : toJsonValue(value);
  }
  return resolveJsonAttribute(key, value);
}

function extract(
  attributes: Attributes,
  keys: readonly string[],
  consumedKeys: string[],
  resolve: Resolver,
): JsonValue | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (value === undefined) continue;
    consumedKeys.push(key);
    return resolve(key, value);
  }
  return undefined;
}

function refine(
  attributes: Attributes,
  type: SpanType | undefined,
  inputKeys: readonly string[],
  outputKeys: readonly string[],
  resolve: Resolver,
): AiSdkRefinement {
  const consumedKeys: string[] = [];
  const input = extract(attributes, inputKeys, consumedKeys, resolve);
  const output = extract(attributes, outputKeys, consumedKeys, resolve);

  const refinement: AiSdkRefinement = { consumedKeys };
  if (type !== undefined) refinement.type = type;
  if (input !== undefined) refinement.input = input;
  if (output !== undefined) refinement.output = output;
  return refinement;
}

/**
 * Classify and extract `input`/`output` from whichever of the two
 * conventions a span's attributes match. Returns `undefined` when neither
 * is present, so the caller's generic mapping is untouched.
 */
export function refineFromAiSdkAttributes(attributes: Attributes): AiSdkRefinement | undefined {
  const operationName = attributes["gen_ai.operation.name"];
  if (typeof operationName === "string") {
    return refine(
      attributes,
      GEN_AI_OPERATION_TYPE[operationName],
      GEN_AI_INPUT_KEYS,
      GEN_AI_OUTPUT_KEYS,
      resolveJsonAttribute,
    );
  }

  const legacyOperationId = attributes["ai.operationId"];
  if (typeof legacyOperationId === "string") {
    const type: SpanType = legacyOperationId === LEGACY_TOOL_OPERATION_ID ? "tool" : "llm";
    return refine(attributes, type, LEGACY_INPUT_KEYS, LEGACY_OUTPUT_KEYS, resolveLegacyAttribute);
  }

  return undefined;
}
