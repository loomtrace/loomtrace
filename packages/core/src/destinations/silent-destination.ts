/**
 * An explicit, do-nothing `LoomDestination`.
 *
 * Item 4.1. This is *not* what powers `destination: "silent"` — that shorthand
 * is special-cased in `resolveDestination()` (`loomtrace.ts`) straight to
 * `null`, and stays that way, because `null` is strictly cheaper than any
 * object here: with no destination at all, `.run()`/`.step()` skip id
 * generation, timestamping and span construction entirely (DESIGN 4.5). Routing
 * through a real `LoomDestination` — even a no-op one — would mean building
 * every span in full and then throwing the result away in `write()`.
 *
 * What this class is for is the rarer case where a concrete `LoomDestination`
 * *value* is needed rather than the string shorthand — composing destinations,
 * testing against the interface, or a framework that always passes an object
 * and wants "discard everything" to be one of the choices.
 */
import type { LoomDestination } from "./destination.js";
import type { TraceNode } from "../schema.js";

export class SilentDestination implements LoomDestination {
  readonly name = "silent";

  write(_trace: TraceNode): void {}
}
