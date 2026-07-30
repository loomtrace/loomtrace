import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OpenTelemetry } from "@ai-sdk/otel";
import { generateText, registerTelemetry, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { LocalDestination, type LoomDestination, type TraceNode } from "@loomtrace/core";
import { LoomTraceSpanProcessor } from "@loomtrace/otel";

/**
 * The agent code below never imports `@loomtrace/*` directly — it just calls
 * `generateText()` the way any Vercel AI SDK user would. Tracing is wired up
 * once, here, by registering `LoomTraceSpanProcessor` on the same
 * `TracerProvider` the AI SDK's own OTel integration reports to. Anything
 * that goes through this provider becomes part of a loomtrace trace with no
 * further instrumentation.
 */
let lastTraceId = "";
const local = new LocalDestination();
const destination: LoomDestination = {
  write(trace: TraceNode) {
    lastTraceId = trace.id;
    return local.write(trace);
  },
};

const provider = new NodeTracerProvider({
  spanProcessors: [new LoomTraceSpanProcessor({ destination })],
});
provider.register();

registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer("gen_ai") }));

const getWeather = tool({
  description: "Get the current weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => {
    await delay(15);
    return { city, tempC: 21, conditions: "sunny" };
  },
});

/**
 * `MockLanguageModelV4` stands in for a real provider (`@ai-sdk/openai`,
 * `@ai-sdk/anthropic`, ...) so this example runs with no API key and no
 * network. Swapping it for `openai("gpt-5.4")` and passing that as `model`
 * below is the only change a real integration needs — everything about the
 * tracing setup above stays the same.
 *
 * It plays two steps by hand: first it calls the tool, then — once the AI
 * SDK feeds the tool result back in as the next message — it answers using
 * that result. This is what `stopWhen: stepCountIs(4)` below is for: without
 * it, `generateText` stops after the first step and never sees the tool
 * result at all.
 */
let step = 0;
const model = new MockLanguageModelV4({
  doGenerate: async () => {
    step += 1;
    if (step === 1) {
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "getWeather",
            input: JSON.stringify({ city: "Lisbon" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 8, text: 8, reasoning: undefined },
        },
        warnings: [],
      };
    }
    return {
      content: [{ type: "text", text: "It's 21°C and sunny in Lisbon." }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 12, text: 12, reasoning: undefined },
      },
      warnings: [],
    };
  },
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const result = await generateText({
  model,
  tools: { getWeather },
  stopWhen: stepCountIs(4),
  prompt: "What's the weather like in Lisbon?",
  telemetry: { isEnabled: true, functionId: "weather-agent" },
});

console.log("Answer:", result.text);

// Flushes every span processor, including LoomTraceSpanProcessor — the trace
// (root span "invoke_agent...", the two agent steps, the model call, and the
// tool call, all as one tree) isn't written to disk until this resolves.
await provider.shutdown();

console.log("\nTrace written — inspect it with:");
console.log(`  node ../../packages/cli/dist/cli.js inspect .loomtrace/traces/${lastTraceId}.json`);
