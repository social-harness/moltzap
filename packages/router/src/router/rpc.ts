/** @file Private correlated RPC between authenticated HTTP and Router operations. */
import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcMiddleware,
  RpcServer,
} from "@effect/rpc";
import {
  AuthenticationFailedError,
  InternalServerError,
  OverloadedError,
  type VerifiedAgentRequest,
} from "@moltzap/client";
import { RouterApi } from "@moltzap/client/internal";
import {
  Context,
  Deferred,
  Effect,
  FiberRef,
  Layer,
  Option,
  Schema,
  type Scope,
} from "effect";
import type { RouterPoll } from "./poll.js";
import type { RouterSend } from "./send.js";

type RouterHandlerError =
  | AuthenticationFailedError
  | OverloadedError
  | InternalServerError;

/** Typed package-private client used by the HTTP adapter. */
export interface RouterRpcClient {
  readonly send: (input: {
    readonly request: RouterApi.RawRouterSendRequest;
  }) => Effect.Effect<RouterApi.RouterSendResult, RouterHandlerError>;
  readonly poll: (input: {
    readonly request: RouterApi.RouterPollRequest;
  }) => Effect.Effect<RouterApi.RouterPollResult, RouterHandlerError>;
}

const currentVerifiedRequest = FiberRef.unsafeMake(
  Option.none<VerifiedAgentRequest>(),
);

/** Private RPC service containing the current verified HTTP request. */
class VerifiedRouterRequest extends Context.Tag(
  "@moltzap/router/VerifiedRouterRequest",
)<VerifiedRouterRequest, VerifiedAgentRequest>() {}

/** Required private RPC middleware for registered-agent operations. */
class RegisteredAgentRequest extends RpcMiddleware.Tag<RegisteredAgentRequest>()(
  "@moltzap/router/RegisteredAgentRequest",
  {
    failure: AuthenticationFailedError,
    provides: VerifiedRouterRequest,
  },
) {}

const registeredAgentRequestLayer = Layer.succeed(RegisteredAgentRequest, () =>
  FiberRef.get(currentVerifiedRequest).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new AuthenticationFailedError()),
        onSome: Effect.succeed,
      }),
    ),
  ),
);

const handlerErrors = Schema.Union(OverloadedError, InternalServerError);
const sendRpc = Rpc.make("send", {
  payload: { request: RouterApi.RawRouterSendRequest },
  success: RouterApi.RouterSendResult,
  error: handlerErrors,
}).middleware(RegisteredAgentRequest);
const pollRpc = Rpc.make("poll", {
  payload: { request: RouterApi.RouterPollRequest },
  success: RouterApi.RouterPollResult,
  error: handlerErrors,
}).middleware(RegisteredAgentRequest);

const routerRpcGroup = RpcGroup.make(sendRpc, pollRpc);

/**
 * Connects private typed operations directly to their handlers.
 *
 * @param input Domain handlers for both correlated operations.
 * @param input.send Send domain handler.
 * @param input.poll Poll domain handler.
 * @returns A scoped in-process client with typed failures.
 */
export const makeRouterRpcClient = (input: {
  readonly send: RouterSend;
  readonly poll: RouterPoll;
}): Effect.Effect<RouterRpcClient, never, Scope.Scope> => {
  const handlerLayer = makeRouterRpcHandlersLayer(input);
  return Effect.gen(function* () {
    type ClientConnection = Effect.Effect.Success<
      ReturnType<
        typeof RpcClient.makeNoSerialization<
          typeof sendRpc | typeof pollRpc,
          never
        >
      >
    >;
    const clientReady = yield* Deferred.make<ClientConnection>();
    const server = yield* RpcServer.makeNoSerialization(routerRpcGroup, {
      onFromServer: (message) =>
        Deferred.await(clientReady).pipe(
          Effect.flatMap((client) => client.write(message)),
        ),
    });
    const client = yield* RpcClient.makeNoSerialization(routerRpcGroup, {
      supportsAck: true,
      onFromClient: ({ message }) => server.write(0, message),
    });
    yield* Deferred.succeed(clientReady, client);
    return client.client;
  }).pipe(
    Effect.provide(handlerLayer),
    Effect.provide(registeredAgentRequestLayer),
    Effect.withSpan("makeRouterRpcClient"),
  );
};

/**
 * Limits one verified request proof to the dynamic extent of one RPC call.
 *
 * @param verifiedRequest Authentication proof for the current HTTP request.
 * @param effect Correlated private RPC call.
 * @returns The call with the proof installed only for its dynamic extent.
 */
export const withVerifiedRouterRequest = <A, E, R>(
  verifiedRequest: VerifiedAgentRequest,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.locally(currentVerifiedRequest, Option.some(verifiedRequest))(effect);

function makeRouterRpcHandlersLayer(input: {
  readonly send: RouterSend;
  readonly poll: RouterPoll;
}) {
  return routerRpcGroup.toLayer({
    send: ({ request }) =>
      Effect.gen(function* () {
        const verifiedRequest = yield* VerifiedRouterRequest;
        return yield* input.send.handle(request, verifiedRequest);
      }),
    poll: ({ request }) =>
      Effect.gen(function* () {
        const verifiedRequest = yield* VerifiedRouterRequest;
        return yield* input.poll.handle(request, verifiedRequest);
      }),
  });
}
