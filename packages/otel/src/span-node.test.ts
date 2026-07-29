import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { toPendingSpanNode, toSpanNode } from "./span-node.js";

const TRACE_ID = "4f7a1c9e6b2d48a3f0c5e19d7b3a6d2c";
const ROOT_SPAN_ID = "a1b2c3d4e5f60718";
const CHILD_SPAN_ID = "b2c3d4e5f6071829";

function fakeSpan(overrides: Record<string, unknown>): ReadableSpan {
  return {
    name: "generateText",
    kind: 0,
    spanContext: () => ({ traceId: TRACE_ID, spanId: ROOT_SPAN_ID, traceFlags: 1 }),
    startTime: [1_753_701_753, 0],
    endTime: [1_753_701_754, 500_000_000],
    status: { code: SpanStatusCode.OK },
    attributes: {},
    links: [],
    events: [],
    duration: [1, 500_000_000],
    ended: true,
    ...overrides,
  } as unknown as ReadableSpan;
}

describe("toSpanNode — parent detection across sdk-trace-base majors", () => {
  it("reads a root span: neither major sets a parent field", () => {
    // A root span looks the same at runtime on both majors — neither
    // `parentSpanContext` (2.x) nor `parentSpanId` (1.x) is set — so one case
    // covers both.
    const span = fakeSpan({});

    expect(toSpanNode(span).parentId).toBeNull();
    expect(toSpanNode(span).type).toBe("run");
  });

  it("reads a child span with the current (2.x) shape: parentSpanContext set", () => {
    const span = fakeSpan({
      spanContext: () => ({ traceId: TRACE_ID, spanId: CHILD_SPAN_ID, traceFlags: 1 }),
      parentSpanContext: { traceId: TRACE_ID, spanId: ROOT_SPAN_ID, traceFlags: 1 },
    });

    expect(toSpanNode(span).parentId).toBe(ROOT_SPAN_ID);
    expect(toSpanNode(span).type).toBe("step");
  });

  it("reads a child span with the legacy (1.x) shape: parentSpanId set", () => {
    const span = fakeSpan({
      spanContext: () => ({ traceId: TRACE_ID, spanId: CHILD_SPAN_ID, traceFlags: 1 }),
      parentSpanId: ROOT_SPAN_ID,
    });

    expect(toSpanNode(span).parentId).toBe(ROOT_SPAN_ID);
    expect(toSpanNode(span).type).toBe("step");
  });

  it("prefers parentSpanContext over a stray legacy field, if somehow both are present", () => {
    const span = fakeSpan({
      spanContext: () => ({ traceId: TRACE_ID, spanId: CHILD_SPAN_ID, traceFlags: 1 }),
      parentSpanContext: { traceId: TRACE_ID, spanId: ROOT_SPAN_ID, traceFlags: 1 },
      parentSpanId: "0000000000000000",
    });

    expect(toSpanNode(span).parentId).toBe(ROOT_SPAN_ID);
  });
});

describe("toSpanNode — structural fields", () => {
  it("maps ids, name, timing and status", () => {
    const span = fakeSpan({});

    expect(toSpanNode(span)).toEqual({
      id: ROOT_SPAN_ID,
      parentId: null,
      name: "generateText",
      type: "run",
      startTime: "2025-07-28T11:22:33.000000000Z",
      endTime: "2025-07-28T11:22:34.500000000Z",
      durationMs: 1500,
      status: "ok",
    });
  });

  it("maps SpanStatusCode.UNSET to \"unset\" and ERROR to \"error\" with a SpanError attached", () => {
    const unset = fakeSpan({ status: { code: SpanStatusCode.UNSET } });
    expect(toSpanNode(unset).status).toBe("unset");
    expect(toSpanNode(unset).error).toBeUndefined();

    const errored = fakeSpan({ status: { code: SpanStatusCode.ERROR, message: "boom" } });
    expect(toSpanNode(errored).status).toBe("error");
    expect(toSpanNode(errored).error).toEqual({ name: "Error", message: "boom" });
  });

  it("un-flattens attributes into metadata, and omits metadata when there are none", () => {
    const withAttributes = fakeSpan({
      attributes: { "gen_ai.request.model": "gpt-5.4" },
    });
    expect(toSpanNode(withAttributes).metadata).toEqual({
      gen_ai: { request: { model: "gpt-5.4" } },
    });

    expect(toSpanNode(fakeSpan({})).metadata).toBeUndefined();
  });
});

describe("toSpanNode — gen_ai.*/ai.* refinement", () => {
  it("refines type and pulls input/output for a gen_ai chat span", () => {
    const span = fakeSpan({
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "hi" }]),
        "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "hello" }]),
      },
    });

    const node = toSpanNode(span);

    expect(node.type).toBe("llm");
    expect(node.input).toEqual([{ role: "user", content: "hi" }]);
    expect(node.output).toEqual([{ role: "assistant", content: "hello" }]);
    // The message payloads became `input`/`output` — they should not also
    // sit in `metadata`, or every trace stores each message array twice.
    expect(node.metadata).toEqual({
      gen_ai: { operation: { name: "chat" }, request: { model: "gpt-5.4" } },
    });
  });

  it("leaves the structural default type when no recognized convention is present", () => {
    const span = fakeSpan({ attributes: { "http.method": "GET" } });
    expect(toSpanNode(span).type).toBe("run");
  });
});

describe("toPendingSpanNode", () => {
  it("builds an unset placeholder with no endTime or durationMs", () => {
    const span = fakeSpan({});

    expect(toPendingSpanNode(span)).toEqual({
      id: ROOT_SPAN_ID,
      parentId: null,
      name: "generateText",
      type: "run",
      startTime: "2025-07-28T11:22:33.000000000Z",
      status: "unset",
    });
  });

  it("refines type from attributes already visible at onStart", () => {
    const span = fakeSpan({
      spanContext: () => ({ traceId: TRACE_ID, spanId: CHILD_SPAN_ID, traceFlags: 1 }),
      parentSpanContext: { traceId: TRACE_ID, spanId: ROOT_SPAN_ID, traceFlags: 1 },
      attributes: { "gen_ai.operation.name": "execute_tool" },
    });

    expect(toPendingSpanNode(span).type).toBe("tool");
  });
});
