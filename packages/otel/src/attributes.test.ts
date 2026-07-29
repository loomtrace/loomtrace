import type { Attributes } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { attributesToMetadata } from "./attributes.js";

describe("attributesToMetadata", () => {
  it("returns undefined for an empty bag", () => {
    expect(attributesToMetadata({})).toBeUndefined();
  });

  it("passes dot-less keys through unchanged", () => {
    expect(attributesToMetadata({ method: "GET", status: 200 })).toEqual({
      method: "GET",
      status: 200,
    });
  });

  it("nests a dotted key one level deep", () => {
    expect(attributesToMetadata({ "http.method": "GET", "http.status": 200 })).toEqual({
      http: { method: "GET", status: 200 },
    });
  });

  it("nests dotted keys into objects, gen_ai-style", () => {
    const attributes: Attributes = {
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 34,
    };

    expect(attributesToMetadata(attributes)).toEqual({
      gen_ai: {
        request: { model: "gpt-5.4" },
        usage: { input_tokens: 12, output_tokens: 34 },
      },
    });
  });

  it("converts array attribute values, mapping undefined/null entries to null", () => {
    expect(attributesToMetadata({ tags: ["a", undefined, null, "b"] })).toEqual({
      tags: ["a", null, null, "b"],
    });
  });

  it("drops attributes whose value is undefined", () => {
    expect(attributesToMetadata({ present: "yes", absent: undefined })).toEqual({
      present: "yes",
    });
  });

  it("falls back to the flat key when a path collides with a scalar", () => {
    // "ai.model" as a bare string, and "ai.model.id" trying to nest under it —
    // not a shape real instrumentation produces, but not this bridge's to
    // assume about arbitrary attributes either.
    const attributes: Attributes = {
      "ai.model": "opaque-string",
      "ai.model.id": "gpt-5.4",
    };

    expect(attributesToMetadata(attributes)).toEqual({
      ai: { model: "opaque-string" },
      "ai.model.id": "gpt-5.4",
    });
  });

  it("falls back to the flat key when a deeper namespace already claimed the leaf", () => {
    const attributes: Attributes = {
      "ai.model.id": "gpt-5.4",
      "ai.model": "opaque-string",
    };

    expect(attributesToMetadata(attributes)).toEqual({
      ai: { model: { id: "gpt-5.4" } },
      "ai.model": "opaque-string",
    });
  });
});
