# @loomtrace/core — design

This document records the decisions behind `@loomtrace/core` and is written
**before** the implementation, on purpose: the trace JSON format and the shape
of the public API are contracts, and contracts are cheapest to argue about
while nothing depends on them yet.

Two different kinds of thing are described here, with very different stability:

| | Governed by | Breaking change means |
| --- | --- | --- |
| The trace JSON format | `SCHEMA_VERSION` (an integer) | Existing trace files stop being readable |
| The TypeScript API | semver of the npm package | Existing code stops compiling |

The source of truth for the types themselves is
[`src/schema.ts`](./src/schema.ts), [`src/api.ts`](./src/api.ts),
[`src/destination.ts`](./src/destination.ts) and
[`src/version.ts`](./src/version.ts). This document explains *why* they look
the way they do; where prose and types disagree, the types win.

Status: `SCHEMA_VERSION` is `0`, which means **unstable**. Nothing here is
promised until the first npm release.

---

## 1. What core is, and what follows from it

`@loomtrace/core` is embedded **inside** an agent framework as an
implementation detail. The framework author constructs and owns the
`LoomTrace` instance; the agent developer downstream sees only that
framework's own flag, something like `trace: "local" | "silent"`.

Everything below follows from being somebody else's transitive dependency:

- **Off by default.** `destination` defaults to `"silent"`. Writing files into
  a user's working directory is not a decision a dependency they never
  installed on purpose gets to make.
- **The tracer never breaks the program.** Any failure inside loomtrace — a
  destination that rejects, a value that will not serialize — is caught and
  reported through `onError`, never thrown into the traced code.
- **Tracing never changes control flow.** `.run()` and `.step()` return exactly
  what their callback returned, with the same type and the same synchronicity.
  Exceptions propagate unchanged; loomtrace observes control flow, it does not
  participate in it.
- **No monkey-patching and no globals.** An explicit instance, plus an optional
  OpenTelemetry bridge in `@loomtrace/otel`. Two frameworks in the same process
  can each have their own tracer without discovering each other.

Out of scope for core: reading OpenTelemetry spans (`@loomtrace/otel`),
rendering traces (`@loomtrace/cli`), and shipping traces to a server (a future
cloud destination — which is a `LoomDestination`, not a change to core).

---

## 2. The trace format

A trace is a header plus a **flat** list of spans. See
[`src/schema.ts`](./src/schema.ts).

```json
{
  "schemaVersion": 0,
  "id": "4f7a1c9e6b2d48a3f0c5e19d7b3a6d2c",
  "name": "answer-question",
  "startTime": "2026-07-28T11:22:33.123456789Z",
  "endTime": "2026-07-28T11:22:35.987654321Z",
  "durationMs": 2864.197532,
  "status": "ok",
  "metadata": { "release": "2026.7.28", "env": "production" },
  "spans": [
    {
      "id": "a1b2c3d4e5f60718",
      "parentId": null,
      "name": "answer-question",
      "type": "run",
      "startTime": "2026-07-28T11:22:33.123456789Z",
      "endTime": "2026-07-28T11:22:35.987654321Z",
      "durationMs": 2864.197532,
      "status": "ok",
      "input": { "question": "why is the build slow?" },
      "output": { "answer": "type-checking dominates" }
    },
    {
      "id": "b2c3d4e5f6071829",
      "parentId": "a1b2c3d4e5f60718",
      "name": "retrieve",
      "type": "retrieval",
      "startTime": "2026-07-28T11:22:33.201000000Z",
      "endTime": "2026-07-28T11:22:33.412500000Z",
      "durationMs": 211.5,
      "status": "ok",
      "metadata": { "hits": 4 }
    }
  ]
}
```

### 2.1 Spans are flat, parentage is a field

Nesting is expressed by `parentId`, not by containment. OpenTelemetry, Langfuse
and LangSmith all converge here, and the reason is robustness: spans can be
appended in any order as they close, and a span whose parent is missing or
never closed is still a readable record. Building the tree is the reader's job
— it is a single pass, and it is the only part that has to cope with a
truncated file.

Exactly one span has `parentId: null`; every other `parentId` refers to an `id`
in the same list.

### 2.2 Timestamps are ISO 8601 with exactly nine fractional digits

`2026-07-28T11:22:33.123456789Z`, always nine digits, always UTC.

- OpenTelemetry timestamps are nanosecond-precision, so nine digits make the
  bridge in `@loomtrace/otel` lossless in both directions.
- A fixed digit count means lexicographic ordering equals chronological
  ordering, so a reader can sort spans without parsing dates.

**Trap:** `new Date(iso)` parses these but truncates to milliseconds, so
`new Date(iso).toISOString()` silently drops digits 4–9. These strings are
formatted directly and are never round-tripped through `Date`.

### 2.3 `durationMs` is denormalized on purpose

It is derivable from `startTime` and `endTime`, and it is stored anyway: the
CLI sorts and colours by duration on every render, and it is fractional so that
sub-millisecond steps do not all collapse to `0`.

### 2.4 Values are JSON, and that is enforced by the type

`input`, `output` and `metadata` are `JsonValue`. Class instances, functions
and circular references are the caller's to project into JSON — or ours to
serialize defensively at the destination boundary. The alternative, accepting
`unknown` and hoping, turns the schema from a contract into a suggestion.

Metadata is allowed to nest. OpenTelemetry attributes are flat, which forces
conventions like `langfuse.metadata.db.host`; we write JSON files, so that
constraint is not ours to inherit.

### 2.5 `status` has three values, not two

`"ok" | "error" | "unset"`. `"unset"` is a span that started and never closed —
a crashed process, a killed container — and it is what a reader sees at the
tail of a partially flushed trace. It is not a failure, it is a missing answer,
and the CLI renders it as a third thing.

### 2.6 `SpanType` is an open union

`"run" | "step" | "llm" | "tool" | "retrieval" | (string & {})`. The listed
values autocomplete and cover what loomtrace emits; a framework embedding us
can use its own vocabulary without patching our file. LangSmith shipped a
closed union here and later deprecated it in favour of a raw string; this is
that lesson applied up front.

### 2.7 A failure is captured structurally, and to the bottom of the chain

`SpanError` is `name` / `message` / `stack`, plus `cause` and `errors`, and the
last two are there because the top of a failure is rarely the informative part:
"generation failed" wraps "request failed" wraps `ECONNREFUSED`, and only the
last one can be acted on. `errors` does the same job for the `AggregateError`
that comes out of `Promise.any`, which otherwise records "All promises were
rejected" — everything failed, nothing about why. The chain is followed five
levels deep, with a cycle guard.

The thrown value itself is never stored: it is arbitrary JavaScript and usually
not serializable.

That "arbitrary" is meant literally, and it is why the capture code is written
defensively. `catch` catches anything — a string, `undefined`, a `Symbol`, a
plain object, an object whose `message` is a getter that throws, an `Error`
from another realm that fails `instanceof Error`. Errors are recognized by
shape rather than by prototype, every property read tolerates a throw, and a
thrown payload is recorded as JSON rather than as `[object Object]`. A tracer
that crashes while recording a failure crashes in the one code path that is
already on fire.

### 2.8 `cancelled` is a flag on a failure, not a status of its own

A span cut short from outside — an `AbortSignal` fired, a deadline elapsed —
gets `status: "error"`, the error that carried it, and `cancelled: true`. The
field is optional and only ever `true`; absent means not cancelled. The
argument for a flag rather than a fourth `status` is in §4.11.

---

## 3. Schema versioning

`schemaVersion` is a **single integer**, not a semver string. See
[`src/version.ts`](./src/version.ts).

Every field a reader cares about is either required or optional, and optional
fields are detected by presence. So an additive change carries no information a
reader cannot already get by looking, and a minor version number would be a
second, weaker way of asking a question the data already answers — eventually
the two disagree. What remains is the one question the data cannot answer:
*was this written under rules I still understand?* That is a counter.
Sourcemaps (`version: 3`) and npm lockfiles (`lockfileVersion: 3`) landed here
for the same reason.

This is independent of the npm version of the package. `@loomtrace/core` will
reach `1.0.0` with the schema at `1`, and will keep shipping minor versions
that do not touch the schema at all.

| Requires bumping `SCHEMA_VERSION` | Does not |
| --- | --- |
| Removing or renaming a field | Adding an optional field |
| Making an optional field required | Adding a member to an open union |
| Narrowing a type, or removing a member from a closed union | Widening a type |
| Changing the meaning, units or format of an existing field | Runtime API changes that leave the JSON unchanged |

That last row is the one that will actually be missed: it is invisible to a
typechecker.

**Reader obligations**, without which the additive column above is not really
non-breaking:

- ignore unknown fields; never reject a trace for containing one;
- treat an absent optional field as absent, not as a default;
- treat an unrecognized `SpanType` as an opaque label, not an error.

`checkSchemaVersion(value)` classifies a parsed `schemaVersion` as
`"ok" | "too-new" | "too-old" | "invalid"`. It takes `unknown` because it is
meant to be the first thing applied to parsed JSON, before any validation.
`"invalid"` is separate from `"too-old"` deliberately: a file with no usable
`schemaVersion` is probably not a trace at all, and "this is not a trace file"
is a more useful message than "this trace is too old".

`SCHEMA_VERSION` goes to `1` at the first npm release — after the CLI and the
OpenTelemetry bridge have exercised the schema, since those are the two
consumers most likely to prove a field wrong.

---

## 4. The API

See [`src/api.ts`](./src/api.ts).

```ts
const tracer = new LoomTrace({ destination: "local" });

const answer = await tracer.run("answer-question", { input: { question } }, async (span) => {
  const docs = await tracer.step("retrieve", () => retrieve(question));
  span.setMetadata({ hits: docs.length });
  return generate(docs);
});
```

### 4.1 Callback form, not manual start/end

`.run(name, fn)` and `.step(name, fn)` take the work as a callback, which makes
the span's lifetime exactly the callback's — there is nothing to leak and no
`end()` to forget. It is the shape OpenTelemetry's `startActiveSpan` settled
on.

`T` is inferred from the callback, so an async callback yields `Promise<R>` and
a sync one yields `R`. Wrapping a call in `.run()` never changes its type and
never makes it async.

### 4.2 `input` is explicit

LangSmith's `traceable(fn)` and Braintrust's `wrapTraced(fn)` capture
`Parameters<F>` automatically. A callback-shaped API cannot: it never sees the
arguments of the function it wraps. That is a deliberate trade — the framework
embedding loomtrace knows which of its arguments are worth recording, and
`arguments` does not.

Output is the callback's resolved return value by default; `span.setOutput()`
overrides it when the return value is not the interesting part (a `Response`, a
stream, a handle) or is too large to store whole.

### 4.3 `.step()` outside a `.run()` is a no-op

It invokes the callback, returns its value, records nothing, and reports once
through `onError`. It does not throw and does not start an implicit run: a
library calling `.step()` on a path its user never wrapped is a missing trace,
not a broken program.

### 4.4 The span handle

Every callback receives a `LoomSpan`: `id`, `traceId`, `parentId`, plus
`setInput`, `setOutput`, `setMetadata`. There is no `end()`.

`span.step(name, fn)` starts a child of *that* span specifically, regardless of
what is ambiently current — for callback boundaries, queue workers, anywhere
`AsyncLocalStorage` cannot follow. `tracer.step()` is the ambient version and
is what most code should use.

Manually-managed spans, the kind a streaming response that outlives its
function would need, are deferred. Adding them is additive.

### 4.5 `enabled`, `onError`, and lifecycle

`enabled: false` keeps every call site intact — callbacks still run, values
still return — and records nothing, so the embedding framework can forward a
user flag directly instead of branching everywhere.

"Records nothing" is meant literally, and it is the same code path for
`enabled: false` and for `"silent"`: no ids are generated, no span object is
built, nothing is timed. The callback receives a shared, frozen handle whose
`id` and `traceId` are OpenTelemetry's invalid ids — all zeros — so code that
logs them prints something recognizably absent rather than a plausible id that
leads nowhere.

`onError` is the only channel through which loomtrace reports its own failures.
It defaults to a single `console` warning rather than to silence: swallowing
errors is required, hiding them is not.

`flush()` awaits the writes still in flight and then the destination's own
`flush()`. `shutdown()` flushes and releases resources; the instance is
unusable afterwards.

`shutdown()` stops new runs from starting, but not steps: a step only ever adds
to a run that is already open, and a trace that loses its children halfway
through is worse than one that finishes after the lights went out.

### 4.6 What a failure does to the spans around it

The span whose callback threw gets `status: "error"` and the error; the
exception then propagates unchanged, same instance, same stack.

A parent's status follows *its own* callback, not its children's. A step that
fails inside a `try` its run recovers from leaves the run `"ok"` — which is
what actually happened: the agent retried and succeeded. An error that escapes
the run marks both.

Nothing loomtrace does can replace that exception with one of its own. Opening
a span, closing a span, writing a trace — each is wrapped, and a failure in any
of them ends up at `onError` while the caller's control flow continues exactly
as it would have without a tracer. The cost of a bug in here is a missing
trace, never a failed run.

### 4.7 How `.step()` finds its parent

`AsyncLocalStorage`, one storage **per tracer instance** rather than one per
module. A module-level store would be a global by another name: two frameworks
that each embed loomtrace would see each other's runs, and `.step()` on one
tracer could attach to a run opened by the other. It also would not survive
what actually happens in a dependency tree — two copies of this package at
different versions, each with its own module scope. A tracer with no run of its
own open therefore treats an ambient run belonging to a *different* tracer as
no run at all.

A span is appended to `spans` when it opens, not when it closes, so a span that
never finishes is still in the trace as `status: "unset"`.

That is also what a fire-and-forget step becomes: the trace is **sealed** when
its root span closes, and a step still running at that moment stays `"unset"`
in the delivered trace. Nothing writes into a trace after it has been handed
over — the destination owns that object (§5.1) — so a step that closes late is
dropped, and a step *opened* after its run finished runs untraced. Recovering
those needs incremental delivery, which is deferred (§5.2). A late step that
*failed* is the one exception: its error is reported through `onError`, for the
reason in §4.9.

### 4.8 Concurrent steps

`Promise.all` over three `.step()` calls is the shape agent code actually has —
fan out to several tools, gather what comes back — and it is the shape that
breaks a tracer keeping "the current span" in a field, because by the time the
second branch opens a child the field belongs to the third.

`AsyncLocalStorage` is what makes this work, and it needs nothing added to it:
each branch's continuations carry the store that was current when the branch
started, so children attach to their own branch no matter how the branches
interleave. Concurrent `.run()` calls on one tracer are separate traces for the
same reason. There is no "current span" to get wrong, which is the whole
argument for the storage in §4.7.

Branches are *not* waited for. A run ends when its own callback settles, and
`Promise.race` and a rejected `Promise.all` both end it with siblings still in
flight. Those stay `"unset"` in the delivered trace (§4.7) — which is a true
statement about what happened: the work was abandoned, and nobody knows how it
would have ended. Holding the trace open until every branch settles would mean
a `Promise.race` never delivers a trace until its slowest loser finishes.

### 4.9 A traced promise is the caller's promise

`.run()` and `.step()` hand back the promise their callback returned — the same
object, not a `.then()` chained onto it. loomtrace attaches an observer to
close the span when it settles, and takes nothing else from it.

Chaining would put the same rejection in two places, and only one of them is
watched. A step opened to time work that is awaited elsewhere —
`const p = send(); tracer.step("send", () => p); await p;` — leaves the caller
handling theirs and the tracer's copy rejecting with nobody attached, and an
unhandled rejection ends a Node process by default. A tracer that kills a
program whose error handling was already correct has failed at the only thing
§1 asks of it.

The cost is the mirror image, and it is smaller. Observing a promise marks it
handled, so a *fire-and-forget* step that rejects — `void tracer.step(…)`, its
value discarded — no longer reaches `unhandledRejection`. It is recorded on its
span instead, with name, message and cause chain, which is a better place to
read it than a stack on stderr. Where that argument runs out is when the error
reaches no span at all: a step that outlived its run, whose trace was sealed
before it failed. Then it goes to `onError`, because a silently swallowed
failure is the one outcome a tracer must never produce.

Ordering survives this. The observer is attached before `.step()` returns, so
it precedes every handler the caller attaches afterwards, and a span still
closes before the code awaiting it resumes — which is what keeps a branch of a
`Promise.all` inside its parent's lifetime rather than straddling the end of it.

### 4.10 A run inside a run is a child span, not a second trace

An agent calls another agent. Both were written as a `.run()` by whoever wrote
them, and neither knows it is being called by the other — that is the whole
point of composing agents. So `.run()` called while a run of the same tracer is
ambient does **not** open a second trace: it opens a child span of the enclosing
one, and the outer run keeps being the trace.

Two traces would be the more literal reading of "one run, one trace", and it is
the wrong one. The relationship between the caller and the callee *is* the
thing worth recording — a sub-agent that took nine seconds is only interesting
next to the supervisor that waited for it — and two files linked by nothing
lose exactly that. It is also the convention everywhere else: nested
`startActiveSpan` in OpenTelemetry, nested `traceable` in LangSmith, nested
`traced` in Braintrust all continue the trace they are in. A library that
surprised a framework author here would produce a pile of one-span traces from
code that looks obviously nested.

The nested span keeps `type: "run"`. A reader that wants the agent boundaries
back looks for `type === "run" && parentId !== null`, so demoting the run to a
span costs no information.

What it does cost is `traceMetadata`: a nested run has no trace of its own to
annotate. It is folded into that span's `metadata` rather than dropped, and
deliberately *not* merged into the enclosing trace — a sub-agent declaring
`{ session: … }` must not relabel the execution that called it. Where the same
key appears in both, `metadata` wins, since it was meant for this span all
along.

Three edges follow from the rule rather than being separate decisions:

- **Only the enclosing tracer's runs nest.** The context storage is per instance
  (§4.7), so two frameworks that each embed loomtrace produce two traces, as
  they already did for steps.
- **A sealed trace cannot be joined.** A run started from a step that outlived
  its run — the trace already handed over (§4.7) — starts a fresh trace instead
  of vanishing. It is a genuine execution, and a trace nobody expected is better
  than a silence nobody can find.
- **`shutdown()` does not stop it.** Shutdown stops new traces from starting; a
  nested run adds to a trace that is already open, exactly like a step (§4.5).

### 4.11 Cancellation is a flag on an error, not a status of its own

An agent that gives a tool call two seconds and moves on when it does not
answer is working correctly. Recording that under the same heading as
`TypeError: x is not a function` makes every error count useless: the number
that matters — how often did this agent actually break — cannot be recovered
from a trace that files both the same way.

So a cancelled span keeps `status: "error"` and gains `cancelled: true`. It is
a failure, and pretending otherwise loses information too: the work did not
produce its result, and the error that carried it is recorded like any other,
with its cause chain intact. What the flag adds is the distinction between
*cut short* and *wrong*, and a reader counting real breakages writes
`status === "error" && !cancelled`.

Three alternatives, and why not:

- **A fourth `SpanStatus`.** The single most invasive change available: every
  reader that switches on status breaks, the CLI has to learn a fourth colour,
  and the schema's own rule (§3) makes it a version bump for something that is
  additive information. OpenTelemetry has three status codes and puts
  cancellation in the exception it records; that is the same trade made once
  already, by the project with the most readers to break.
- **`status: "unset"`.** Tempting, since "abandoned" sounds like "no answer".
  But `"unset"` means loomtrace *does not know* how the work ended (§2.5), and
  a cancellation is known: a time, a duration, and a reason. Collapsing the two
  would make an unset span mean two different things and leave a reader unable
  to tell a killed container from a satisfied deadline.
- **Metadata.** `metadata: { cancelled: true }` needs no schema change at all,
  and it is exactly where a convention goes to be spelled three different ways
  by three frameworks. Cancellation is common enough to belong in the format.

**How it is detected.** Two independent signals, because neither is sufficient:

1. **The thrown value's shape.** `AbortError` and `TimeoutError` by name,
   `ABORT_ERR` and `ERR_CANCELED` by code — matched by shape rather than by
   class, for the same reason as §2.7: an aborted `fetch` rejects with a
   `DOMException` in one runtime and Node's own `AbortError` in another, and
   neither survives `instanceof` across a realm. The `cause` chain is followed
   at the same depth, because `new Error("generation failed", { cause: abortError })`
   is a framework doing its job, and the outermost error has no trace of the
   abort left in it. An `AggregateError` counts only when *every* one of its
   failures was a cancellation — `Promise.any` where one provider was aborted
   and two returned garbage is a failure, and the two are the part worth
   reading.
2. **An `AbortSignal` passed in options.** Optional, read once, only if the
   callback failed. This is what covers `controller.abort(reason)` with a
   reason of the caller's own, which surfaces as an ordinary error with nothing
   abort-shaped about it — and the real-world case where aborting mid-stream
   surfaces as `TypeError: terminated` from the socket. A caller who passes the
   signal has stated that this work was under its control, so an aborted signal
   is taken at its word.

Consulted *only* on failure, which is what keeps a signal shared across a whole
request from retroactively marking the steps that finished before it fired. And
a callback that catches its own abort and returns what it managed to collect is
`"ok"`: it did not fail, and loomtrace does not overrule a callback about its
own outcome.

**What loomtrace does not do with a signal:** subscribe to it, abort anything,
or close a span when it fires. `AbortSignalLike` is structural — `{ aborted }`
and nothing else — which both states that and lets a polyfilled or cross-realm
signal through. A listener would be a leak to manage and would end a span while
its callback was still running, and a span's lifetime is its callback's (§4.1).

**The other timeout shape is unchanged.** `Promise.race([work, deadline])`
aborts nothing: the run stops waiting, the step keeps running, and the trace is
sealed while it is still open. That span stays `"unset"` (§4.8), not
`cancelled` — nobody ever learned how it ended, which is precisely what
`"unset"` says.

---

## 5. Destinations

A destination is the one part of loomtrace that someone else is expected to
implement. `"silent"` and `"local"` ship here; `"cloud"` comes later; a
framework may want to route traces into its own logging pipeline instead. See
[`src/destination.ts`](./src/destination.ts).

```ts
interface LoomDestination {
  readonly name?: string;
  write(trace: TraceNode): void | Promise<void>;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

type DestinationSpec = "silent" | "local" | LoomDestination;
```

`write` is the only required method, so the smallest destination is
`{ write() {} }` — a sink with no buffer should not implement two empty
promises to satisfy an interface. It may be sync or async; loomtrace never
awaits it at the call site, because `.run()` must not become async just because
a destination is slow.

There is no return value with which a destination can refuse a trace or apply
back-pressure. The traced program must not be able to observe the tracer, so
the only channel for "this did not work" is `onError`.

`"cloud"` can join `DestinationSpec` later, and so can a configured object form
like `{ type: "cloud", apiKey, project }`: `LoomDestination` structurally
requires `write`, so a config object is never mistaken for one.

### 5.1 The contract

**loomtrace guarantees a destination:**

1. `write` is called exactly once per trace, after its root span closes, with a
   complete `TraceNode` — `schemaVersion` included.
2. After that call loomtrace neither reads nor retains the trace. The
   destination owns the object and may keep or mutate it.
3. `write` is never awaited inside `.run()`. A returned promise is tracked, and
   `LoomTrace.flush()` awaits it before calling `flush()` on the destination.
4. A throw or rejection from any method is caught and reported through
   `onError`. It never surfaces in the traced program.
5. Once `shutdown()` has resolved, `write` is not called again.
6. Nothing is called at all when `enabled` is `false`, or when the destination
   is `"silent"`.
7. Concurrent traces are not serialized: calls may overlap and may complete in
   any order.

**A destination owes loomtrace in return:**

1. Tolerate overlapping `write` calls — loomtrace does not queue them.
2. Resolve `flush()` only when everything handed over up to that point is
   actually delivered.
3. Make `shutdown()` flush first, and make it idempotent.
4. Own its retries. Throwing from `write` is allowed and simply means the trace
   was dropped; loomtrace does not retry, and losing a trace is preferable to
   interfering with the program being traced.

### 5.2 Whole traces, not a span stream

The contract is trace-at-a-time. Incremental delivery — handing over each span
as it closes, the way an OpenTelemetry `SpanProcessor.onEnd` does — matters for
a process that dies mid-run and for live tailing, and neither is in scope yet.
It arrives later as an additional *optional* method that existing destinations
can ignore, which is exactly why the required surface is kept to `write` now.

---

## 6. Deliberately unsettled

These are known gaps, not oversights. Each is scheduled.

| Question | Settled in |
| --- | --- |
| Process exits before a flush — is a crashed run recoverable at all? | item 4.4 |
| Incremental span delivery, live tailing | later |
| Manually-managed spans that outlive their function (streaming) | later |
| Sampling, and truncating large `input`/`output` payloads | unscheduled |
| Fanning one tracer out to several destinations at once | unscheduled |

The last two are worth naming even without a date: both are the kind of thing
that is easy to add as configuration and very hard to add as a change to the
trace format, which is why the format above stores whole values and says
nothing about sampling.
