import { describe, expectTypeOf, it } from "vitest";

import type { DestinationSpec, LoomDestination } from "./destination.js";
import type { SpanNode, TraceNode } from "../schema.js";

/**
 * These are type assertions, not behaviour tests — `destination.ts` has no
 * runtime. They are checked by `tsc --noEmit` (`pnpm typecheck`), which covers
 * `src/**\/*.ts` including this file, so a change to the contract fails `ci`
 * rather than silently passing as a no-op at runtime.
 */

describe("LoomDestination", () => {
  it("is satisfied by a single write method", () => {
    // The floor of the contract: a destination should not have to implement
    // anything it does not need.
    const minimal = {
      write() {},
    } satisfies LoomDestination;

    expectTypeOf(minimal).toExtend<LoomDestination>();
  });

  it("accepts a synchronous or an asynchronous write", () => {
    const sync = { write(_trace: TraceNode): void {} } satisfies LoomDestination;
    const async = {
      async write(_trace: TraceNode): Promise<void> {},
    } satisfies LoomDestination;

    expectTypeOf(sync).toExtend<LoomDestination>();
    expectTypeOf(async).toExtend<LoomDestination>();
    expectTypeOf<LoomDestination["write"]>().returns.toEqualTypeOf<
      void | Promise<void>
    >();
  });

  it("hands write a complete trace", () => {
    expectTypeOf<LoomDestination["write"]>().parameters.toEqualTypeOf<
      [TraceNode]
    >();
  });

  it("makes the lifecycle optional but keeps it async", () => {
    const buffered = {
      name: "buffered",
      write(_trace: TraceNode): void {},
      async flush(): Promise<void> {},
      async shutdown(): Promise<void> {},
    } satisfies LoomDestination;

    expectTypeOf(buffered).toExtend<LoomDestination>();
    expectTypeOf<LoomDestination["flush"]>().toEqualTypeOf<
      (() => Promise<void>) | undefined
    >();
    expectTypeOf<LoomDestination["shutdown"]>().toEqualTypeOf<
      (() => Promise<void>) | undefined
    >();
  });

  it("rejects an object with no write", () => {
    // @ts-expect-error `write` is the one required method.
    const noWrite: LoomDestination = { name: "logger" };
    void noWrite;
  });

  it("rejects a fire-and-forget flush", () => {
    const syncFlush: LoomDestination = {
      write() {},
      // @ts-expect-error flush must report completion, so it returns a promise.
      flush() {},
    };
    void syncFlush;
  });

  it("makes onSpanUpdate optional, keeps it sync-or-async, and hands it the span plus its trace", () => {
    const withoutIt = { write() {} } satisfies LoomDestination;
    const sync = {
      write() {},
      onSpanUpdate(_span: SpanNode, _trace: TraceNode): void {},
    } satisfies LoomDestination;
    const async = {
      write() {},
      async onSpanUpdate(_span: SpanNode, _trace: TraceNode): Promise<void> {},
    } satisfies LoomDestination;

    expectTypeOf(withoutIt).toExtend<LoomDestination>();
    expectTypeOf(sync).toExtend<LoomDestination>();
    expectTypeOf(async).toExtend<LoomDestination>();

    type OnSpanUpdate = NonNullable<LoomDestination["onSpanUpdate"]>;
    expectTypeOf<OnSpanUpdate>().returns.toEqualTypeOf<void | Promise<void>>();
    expectTypeOf<OnSpanUpdate>().parameters.toEqualTypeOf<[SpanNode, TraceNode]>();
  });
});

describe("DestinationSpec", () => {
  it("accepts the shorthands and a destination object", () => {
    const silent: DestinationSpec = "silent";
    const local: DestinationSpec = "local";
    const custom: DestinationSpec = { write() {} };

    expectTypeOf(silent).toExtend<DestinationSpec>();
    expectTypeOf(local).toExtend<DestinationSpec>();
    expectTypeOf(custom).toExtend<DestinationSpec>();
  });

  it("rejects a shorthand that does not exist yet", () => {
    // `"cloud"` is a planned destination, not a shipped one. When it lands,
    // this line starts failing — which is the reminder to update the docs and
    // the resolver along with the union.
    // @ts-expect-error unknown shorthand.
    const cloud: DestinationSpec = "cloud";
    void cloud;
  });
});
