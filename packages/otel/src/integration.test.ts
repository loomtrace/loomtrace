/**
 * End-to-end: a real `NodeTracerProvider`, spans shaped the way Vercel AI
 * SDK's OTel bridge actually emits them, `LoomTraceSpanProcessor` in front of
 * a real `LocalDestination`, and the file that destination writes read back
 * off disk. The other tests in this package check the mapping and the
 * processor's own lifecycle in isolation; this one checks that what lands on
 * disk is a file a completely independent reader — one that only knows
 * `@loomtrace/core`'s public types — could load and trust.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { context as otelContext, SpanStatusCode, trace as traceApi } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { checkSchemaVersion, LocalDestination, SCHEMA_VERSION } from "@loomtrace/core";
import type { SpanNode, TraceNode } from "@loomtrace/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LoomTraceSpanProcessor } from "./span-processor.js";

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Structural conformance to `TraceNode`/`SpanNode` — every required field
 * present with the right shape, every optional field either absent or valid,
 * exactly one root, and every non-root `parentId` resolving within the same
 * trace. A reader is entitled to assume all of this; a `toMatchObject` on a
 * handful of fields would not actually prove it.
 */
function assertConformsToSchema(value: unknown): asserts value is TraceNode {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  const candidate = value as TraceNode;

  expect(checkSchemaVersion(candidate.schemaVersion)).toBe("ok");
  expect(candidate.schemaVersion).toBe(SCHEMA_VERSION);
  expect(candidate.id).toMatch(TRACE_ID_PATTERN);
  expect(typeof candidate.name).toBe("string");
  expect(candidate.startTime).toMatch(TIMESTAMP_PATTERN);
  expect(["ok", "error", "unset"]).toContain(candidate.status);
  expect(Array.isArray(candidate.spans)).toBe(true);
  if (candidate.endTime !== undefined) expect(candidate.endTime).toMatch(TIMESTAMP_PATTERN);
  if (candidate.durationMs !== undefined) expect(candidate.durationMs).toBeGreaterThanOrEqual(0);

  const byId = new Map(candidate.spans.map((span) => [span.id, span]));
  let roots = 0;

  for (const span of candidate.spans) {
    expect(span.id).toMatch(SPAN_ID_PATTERN);
    expect(typeof span.name).toBe("string");
    expect(typeof span.type).toBe("string");
    expect(span.startTime).toMatch(TIMESTAMP_PATTERN);
    expect(["ok", "error", "unset"]).toContain(span.status);
    if (span.endTime !== undefined) expect(span.endTime).toMatch(TIMESTAMP_PATTERN);
    if (span.durationMs !== undefined) expect(span.durationMs).toBeGreaterThanOrEqual(0);

    if (span.parentId === null) {
      roots++;
    } else {
      expect(span.parentId).toMatch(SPAN_ID_PATTERN);
      expect(byId.has(span.parentId)).toBe(true);
    }
  }

  expect(roots).toBe(1);
}

describe("otel bridge → core schema, end to end", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loomtrace-otel-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a real LocalDestination file that conforms to the core TraceNode schema", async () => {
    const processor = new LoomTraceSpanProcessor({ destination: new LocalDestination({ dir }) });
    const provider = new NodeTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("integration-test");

    // A `chat gpt-5.4` root shaped like the gen_ai.* convention's default
    // Telemetry implementation, with a nested provider call and a tool
    // invocation underneath it — the multi-span shape one generateText()
    // call with tool use actually produces.
    const root = tracer.startSpan("chat gpt-5.4");
    root.setAttribute("gen_ai.operation.name", "chat");
    root.setAttribute("gen_ai.request.model", "gpt-5.4");
    root.setAttribute("gen_ai.usage.input_tokens", 42);
    root.setAttribute("gen_ai.usage.output_tokens", 17);
    root.setAttribute(
      "gen_ai.input.messages",
      JSON.stringify([{ role: "user", content: "what's the weather in NYC?" }]),
    );
    root.setAttribute(
      "gen_ai.output.messages",
      JSON.stringify([{ role: "assistant", content: "It's 72°F and sunny." }]),
    );
    const rootCtx = traceApi.setSpan(otelContext.active(), root);

    const doGenerate = tracer.startSpan("doGenerate", undefined, rootCtx);
    doGenerate.setAttribute("gen_ai.response.model", "gpt-5.4-0613");
    doGenerate.setStatus({ code: SpanStatusCode.OK });
    doGenerate.end();

    const tool = tracer.startSpan("execute_tool getWeather", undefined, rootCtx);
    tool.setAttribute("gen_ai.operation.name", "execute_tool");
    tool.setAttribute("gen_ai.tool.name", "getWeather");
    tool.setAttribute("gen_ai.tool.call.arguments", JSON.stringify({ city: "NYC" }));
    tool.setAttribute("gen_ai.tool.call.result", JSON.stringify({ tempF: 72, condition: "sunny" }));
    tool.setStatus({ code: SpanStatusCode.OK });
    tool.end();

    root.setStatus({ code: SpanStatusCode.OK });
    root.end();

    await processor.shutdown();

    const traceId = root.spanContext().traceId;
    const raw = await readFile(join(dir, `${traceId}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);

    assertConformsToSchema(parsed);
    expect(parsed.id).toBe(traceId);
    expect(parsed.status).toBe("ok");
    expect(parsed.spans).toHaveLength(3);

    const rootNode = parsed.spans.find((span) => span.parentId === null) as SpanNode;
    expect(rootNode.type).toBe("llm");
    expect(rootNode.input).toEqual([{ role: "user", content: "what's the weather in NYC?" }]);
    expect(rootNode.output).toEqual([{ role: "assistant", content: "It's 72°F and sunny." }]);
    expect(rootNode.metadata).toMatchObject({
      gen_ai: { usage: { input_tokens: 42, output_tokens: 17 } },
    });

    const toolNode = parsed.spans.find((span) => span.name === "execute_tool getWeather") as SpanNode;
    expect(toolNode.type).toBe("tool");
    expect(toolNode.parentId).toBe(rootNode.id);
    expect(toolNode.input).toEqual({ city: "NYC" });
    expect(toolNode.output).toEqual({ tempF: 72, condition: "sunny" });

    const generateNode = parsed.spans.find((span) => span.name === "doGenerate") as SpanNode;
    expect(generateNode.type).toBe("step");
    expect(generateNode.parentId).toBe(rootNode.id);
  });
});
