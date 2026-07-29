import type { JsonValue } from "@loomtrace/core";

export interface SpanUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cost?: number;
}

function readNumberPath(
  metadata: Record<string, JsonValue>,
  path: readonly string[],
): number | undefined {
  let value: JsonValue | undefined = metadata;
  for (const key of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = value[key];
  }
  return typeof value === "number" ? value : undefined;
}

/**
 * Best-effort read of token counts / cost out of a span's free-form
 * `metadata`, for display only — there is no fixed schema for this yet, just
 * the handful of shapes actually seen in practice: the two OpenTelemetry
 * attribute conventions the `@loomtrace/otel` bridge un-flattens into
 * `metadata` (`gen_ai.usage.*`, the legacy `ai.usage.*`), plus a flat
 * `tokens`/`cost` pair for callers that set `metadata` by hand. Returns
 * `undefined` rather than a partially-filled object when none of them match,
 * so the caller can skip the line entirely instead of printing "tokens: —".
 */
export function extractUsage(metadata: Record<string, JsonValue> | undefined): SpanUsage | undefined {
  if (!metadata) return undefined;

  const inputTokens =
    readNumberPath(metadata, ["gen_ai", "usage", "input_tokens"]) ??
    readNumberPath(metadata, ["ai", "usage", "promptTokens"]) ??
    readNumberPath(metadata, ["tokens", "input"]);
  const outputTokens =
    readNumberPath(metadata, ["gen_ai", "usage", "output_tokens"]) ??
    readNumberPath(metadata, ["ai", "usage", "completionTokens"]) ??
    readNumberPath(metadata, ["tokens", "output"]);
  const cost = readNumberPath(metadata, ["cost"]);

  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(cost !== undefined && { cost }),
  };
}

export function formatUsage(usage: SpanUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`tokens: ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out`);
  }
  if (usage.cost !== undefined) {
    parts.push(`cost: $${usage.cost.toFixed(4)}`);
  }
  return parts.join("  ");
}
