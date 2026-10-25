/** @file Router composition without a platform URL type in its public contract. */
import type { HttpClient } from "@effect/platform";
import { Context, type Duration, type Layer } from "effect";
import type { HttpOrigin } from "../../../identity/index.js";
import { Router as RouterTag } from "./client.js";

/** Send and poll retain the internal Router's exact Effect requirement. */
export type Router = RouterTag;

interface RouterCapability
  extends Context.Tag<Router, Context.Tag.Service<typeof RouterTag>> {
  readonly send: typeof RouterTag.send;
  readonly poll: typeof RouterTag.poll;
  readonly layer: (input: {
    readonly origin: HttpOrigin;
    readonly sendTimeout: Duration.Duration;
    readonly pollTimeout: Duration.Duration;
  }) => Layer.Layer<Router, never, HttpClient.HttpClient>;
}

/** Trusted compositions install the same Router tag using a serialized origin. */
// eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The capability tag shares the name of its Effect requirement.
export const Router: RouterCapability = Object.assign(
  Context.GenericTag<Router, Context.Tag.Service<typeof RouterTag>>(
    RouterTag.key,
  ),
  {
    send: RouterTag.send,
    poll: RouterTag.poll,
    layer: (input: {
      readonly origin: HttpOrigin;
      readonly sendTimeout: Duration.Duration;
      readonly pollTimeout: Duration.Duration;
    }) => RouterTag.layer({ ...input, origin: new URL(input.origin.href) }),
  },
);
