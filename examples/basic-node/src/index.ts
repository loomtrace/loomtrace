import { LoomTrace } from "@loomtrace/core";

/**
 * `destination: "local"` writes each finished trace as JSON under
 * `.loomtrace/traces/<traceId>.json`, viewable with `packages/cli`'s
 * `inspect` command. A real framework would forward this from whatever flag
 * its own users set (see the root README's "embed me inside your framework"
 * example) — here it's just hardcoded.
 */
const tracer = new LoomTrace({
  destination: "local",
  metadata: { service: "basic-node-example" },
});

let traceId = "";

async function answerQuestion(question: string): Promise<string> {
  return tracer.run("answer-question", { input: { question } }, async (span) => {
    traceId = span.traceId;

    const context = await tracer.step("retrieve-context", () => retrieveContext(question));

    // A tool call the agent makes along the way. Steps nest through ambient
    // context (AsyncLocalStorage), so this becomes a sibling of the LLM call
    // below without either one knowing the other exists.
    const price = await tracer.step(
      "call-tool",
      { metadata: { tool: "calculator" } },
      () => callCalculatorTool("3 * 45 * 0.9"),
    );

    // A step that fails without failing the run: the agent tries a
    // shortcut, it misses, and the agent falls back to the LLM anyway. The
    // failed step shows up in the trace tree; the run itself still ends "ok".
    try {
      tracer.step("check-cache", () => {
        throw new Error("cache miss");
      });
    } catch {
      // expected — this is what "fell back" means
    }

    let answer = await tracer.step("call-llm", () => callLlm(question, context, price));

    // Optional: the model isn't sure the discount code is still valid, so
    // it decides — on its own, mid-answer — to make one more tool call to
    // check. This step only exists on runs where the question mentions a
    // code at all; the trace tree differs run to run, same as with a real
    // agent deciding what to do next.
    const discountCode = extractDiscountCode(question);
    if (discountCode !== null) {
      const valid = await tracer.step(
        "verify-discount-code",
        { input: { code: discountCode }, metadata: { tool: "discount-service" } },
        () => verifyDiscountCode(discountCode),
      );
      answer += valid
        ? ` Discount code ${discountCode} is active and included.`
        : ` Note: discount code ${discountCode} could not be verified, so it is not included.`;
    }

    span.setOutput({ answer, price });
    return answer;
  });
}

async function retrieveContext(question: string): Promise<string[]> {
  await delay(20);
  return [`pricing doc relevant to: "${question}"`];
}

async function callLlm(question: string, context: string[], price: number): Promise<string> {
  await delay(40);
  return `Based on ${context.length} document(s): the total for "${question}" comes to $${price.toFixed(2)}.`;
}

async function callCalculatorTool(expression: string): Promise<number> {
  await delay(5);
  return Function(`"use strict"; return (${expression});`)() as number;
}

async function verifyDiscountCode(code: string): Promise<boolean> {
  await delay(15);
  return code.toUpperCase() !== "EXPIRED10";
}

function extractDiscountCode(question: string): string | null {
  return /discount code (\w+)/i.exec(question)?.[1] ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const answer = await answerQuestion(
  "What's the total price for 3 tickets to the July 4th fireworks show, using discount code SUMMER10?",
);
console.log("Answer:", answer);

await tracer.flush();
console.log("\nTrace written — inspect it with:");
console.log(`  node ../../packages/cli/dist/cli.js inspect .loomtrace/traces/${traceId}.json`);
