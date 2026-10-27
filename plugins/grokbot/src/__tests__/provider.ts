/** @file Local HTTP routing; Fetch still handles requests, redirects and aborts. */
import { type HttpApp, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";

/** The caller's scope keeps the real server alive until pending requests close. */
export const localProvider = Effect.fn("GrokTest.localProvider")(function* <E>(
  application: HttpApp.Default<E>,
) {
  const context = yield* Layer.build(NodeHttpServer.layerTest);
  yield* HttpServer.serveEffect(application).pipe(Effect.provide(context));
  const server = Context.get(context, HttpServer.HttpServer);
  const origin = HttpServer.formatAddress(server.address);
  const destinations: string[] = [];
  const signals: AbortSignal[] = [];
  const fetch: typeof globalThis.fetch = (input, options) => {
    const destination = new URL(
      input instanceof Request ? input.url : String(input),
    );
    destinations.push(destination.href);
    if (options?.signal !== undefined && options.signal !== null) {
      signals.push(options.signal);
    }
    return globalThis.fetch(
      new URL(destination.pathname + destination.search, origin),
      options,
    );
  };
  return { fetch, destinations, signals };
});
