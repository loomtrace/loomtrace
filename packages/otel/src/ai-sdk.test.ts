import type { Attributes } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { refineFromAiSdkAttributes } from "./ai-sdk.js";

describe("refineFromAiSdkAttributes — gen_ai.* (current) convention", () => {
  it("classifies a chat span as llm and pulls messages as input/output", () => {
    const attributes: Attributes = {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "hi" }]),
      "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "hello" }]),
    };

    const refinement = refineFromAiSdkAttributes(attributes);

    expect(refinement?.type).toBe("llm");
    expect(refinement?.input).toEqual([{ role: "user", content: "hi" }]);
    expect(refinement?.output).toEqual([{ role: "assistant", content: "hello" }]);
    expect(refinement?.consumedKeys).toEqual(["gen_ai.input.messages", "gen_ai.output.messages"]);
  });

  it("classifies embeddings and rerank spans as llm too", () => {
    expect(refineFromAiSdkAttributes({ "gen_ai.operation.name": "embeddings" })?.type).toBe("llm");
    expect(refineFromAiSdkAttributes({ "gen_ai.operation.name": "rerank" })?.type).toBe("llm");
  });

  it("classifies a tool-execution span as tool and pulls call arguments/result", () => {
    const attributes: Attributes = {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "getWeather",
      "gen_ai.tool.call.arguments": JSON.stringify({ city: "NYC" }),
      "gen_ai.tool.call.result": JSON.stringify({ tempF: 72 }),
    };

    const refinement = refineFromAiSdkAttributes(attributes);

    expect(refinement?.type).toBe("tool");
    expect(refinement?.input).toEqual({ city: "NYC" });
    expect(refinement?.output).toEqual({ tempF: 72 });
    expect(refinement?.consumedKeys).toEqual(["gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]);
  });

  it("leaves type undefined for invoke_agent — the structural root/child default already fits", () => {
    const refinement = refineFromAiSdkAttributes({ "gen_ai.operation.name": "invoke_agent" });
    expect(refinement?.type).toBeUndefined();
    expect(refinement?.consumedKeys).toEqual([]);
  });

  it("falls back to the raw string when a message attribute is not valid JSON", () => {
    const refinement = refineFromAiSdkAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.input.messages": "not json",
    });
    expect(refinement?.input).toBe("not json");
  });

  it("reports no consumed keys when neither input nor output attributes are present", () => {
    const refinement = refineFromAiSdkAttributes({ "gen_ai.operation.name": "chat" });
    expect(refinement?.input).toBeUndefined();
    expect(refinement?.output).toBeUndefined();
    expect(refinement?.consumedKeys).toEqual([]);
  });
});

describe("refineFromAiSdkAttributes — ai.* (legacy) convention", () => {
  it("classifies a tool call as tool and pulls args/result", () => {
    const attributes: Attributes = {
      "ai.operationId": "ai.toolCall",
      "ai.toolCall.name": "getWeather",
      "ai.toolCall.args": JSON.stringify({ city: "NYC" }),
      "ai.toolCall.result": JSON.stringify({ tempF: 72 }),
    };

    const refinement = refineFromAiSdkAttributes(attributes);

    expect(refinement?.type).toBe("tool");
    expect(refinement?.input).toEqual({ city: "NYC" });
    expect(refinement?.output).toEqual({ tempF: 72 });
    expect(refinement?.consumedKeys).toEqual(["ai.toolCall.args", "ai.toolCall.result"]);
  });

  it("classifies any other operationId as llm, preferring prompt.messages over prompt", () => {
    const attributes: Attributes = {
      "ai.operationId": "ai.generateText",
      "ai.prompt": JSON.stringify({ messages: ["root-level prompt"] }),
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
    };

    const refinement = refineFromAiSdkAttributes(attributes);

    expect(refinement?.type).toBe("llm");
    expect(refinement?.input).toEqual([{ role: "user", content: "hi" }]);
    expect(refinement?.consumedKeys).toEqual(["ai.prompt.messages"]);
  });

  it("falls back to ai.prompt when ai.prompt.messages is absent", () => {
    const attributes: Attributes = {
      "ai.operationId": "ai.embed",
      "ai.prompt": JSON.stringify({ messages: ["only the root prompt"] }),
    };

    const refinement = refineFromAiSdkAttributes(attributes);
    expect(refinement?.input).toEqual({ messages: ["only the root prompt"] });
  });

  it("prefers ai.response.object over the plain-text ai.response.text, and never JSON.parses the text", () => {
    const withObject = refineFromAiSdkAttributes({
      "ai.operationId": "ai.generateObject",
      "ai.response.object": JSON.stringify({ answer: 42 }),
      "ai.response.text": "42",
    });
    expect(withObject?.output).toEqual({ answer: 42 });
    expect(withObject?.consumedKeys).toEqual(["ai.response.object"]);

    const withTextOnly = refineFromAiSdkAttributes({
      "ai.operationId": "ai.generateText",
      "ai.response.text": "42",
    });
    expect(withTextOnly?.output).toBe("42");
  });
});

describe("refineFromAiSdkAttributes — neither convention present", () => {
  it("returns undefined", () => {
    expect(refineFromAiSdkAttributes({ "http.method": "GET" })).toBeUndefined();
    expect(refineFromAiSdkAttributes({})).toBeUndefined();
  });
});
