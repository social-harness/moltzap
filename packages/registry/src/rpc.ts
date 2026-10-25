/** @file Private admitted Registry operations and in-process RPC dispatch. */

import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcMiddleware,
  RpcServer,
} from "@effect/rpc";
import {
  type AgentSigningAuthority,
  AuthenticationFailedError,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
} from "@moltzap/client";
import { RegistryApi } from "@moltzap/client/internal";
import {
  Context,
  Deferred,
  Effect,
  FiberRef,
  Layer,
  Option,
  Schema,
} from "effect";
import type { RegistryStorage } from "./storage.js";

interface BootstrapAdmission {
  readonly admitted: true;
}

class BootstrapAdmissionContext extends Context.Tag(
  "@moltzap/client/BootstrapAdmissionContext",
)<BootstrapAdmissionContext, BootstrapAdmission>() {}

/** Required private RPC admission boundary for Registry registration. */
export class RegistryAdmission extends RpcMiddleware.Tag<RegistryAdmission>()(
  "@moltzap/client/RegistryAdmission",
  {
    provides: BootstrapAdmissionContext,
    failure: AuthenticationFailedError,
  },
) {}

const currentAdmission = FiberRef.unsafeMake<Option.Option<BootstrapAdmission>>(
  Option.none(),
);

/**
 * Runs private Registry dispatch with one already-verified admission proof.
 *
 * @param effect Private registration dispatch to admit.
 * @returns The dispatch with its admission proof scoped to the current fiber.
 */
export const withBootstrapAdmission = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.locally(
    currentAdmission,
    Option.some(Object.freeze({ admitted: true as const })),
  )(effect);

const readAdmission = FiberRef.get(currentAdmission).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.fail(new AuthenticationFailedError()),
      onSome: Effect.succeed,
    }),
  ),
);

/** Layer installed only inside the Registry process's private RPC runtime. */
export const registryAdmissionLayer = Layer.succeed(
  RegistryAdmission,
  () => readAdmission,
);

const registerErrors = Schema.Union(
  MalformedRequestError,
  AuthenticationFailedError,
  RouteNotFoundError,
  MethodNotAllowedError,
  VersionMismatchError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  OverloadedError,
  UnavailableError,
  InternalServerError,
);

const publicReadErrors = Schema.Union(
  MalformedRequestError,
  RouteNotFoundError,
  MethodNotAllowedError,
  VersionMismatchError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  OverloadedError,
  UnavailableError,
  InternalServerError,
);

/** Private registration operation including its admission middleware. */
const registerOperation = Rpc.make("register", {
  payload: RegistryApi.RegistryRegisterRequest,
  success: RegistryApi.registerResultSchema,
  error: registerErrors,
}).middleware(RegistryAdmission);

/** Private lookup operation. */
const lookupOperation = Rpc.make("lookup", {
  payload: RegistryApi.RegistryLookupRequest,
  success: RegistryApi.lookupResultSchema,
  error: publicReadErrors,
});

/** Private deterministic list operation. */
const listOperation = Rpc.make("list", {
  payload: RegistryApi.RegistryListRequest,
  success: RegistryApi.listResultSchema,
  error: publicReadErrors,
});

/** The package-private no-serialization Registry operation group. */
const registryOperations = RpcGroup.make(
  registerOperation,
  lookupOperation,
  listOperation,
);

/** Private in-process client for the Registry operation group. */
export type RegistryRpcClient = RpcClient.FromGroup<typeof registryOperations>;

type NoSerializationClient = Effect.Effect.Success<
  ReturnType<
    typeof RpcClient.makeNoSerialization<
      typeof registerOperation | typeof lookupOperation | typeof listOperation,
      never
    >
  >
>;

/** Connects the private Registry RPC client and server in memory. */
export const makeRegistryRpcClient = Effect.gen(function* () {
  const clientReady = yield* Deferred.make<NoSerializationClient>();
  const server = yield* RpcServer.makeNoSerialization(registryOperations, {
    onFromServer: (message) =>
      Deferred.await(clientReady).pipe(
        Effect.flatMap((client) => client.write(message)),
      ),
  });
  const client = yield* RpcClient.makeNoSerialization(registryOperations, {
    supportsAck: true,
    onFromClient: ({ message }) => server.write(0, message),
  });
  yield* Deferred.succeed(clientReady, client);
  return client.client;
}).pipe(Effect.withSpan("makeRegistryRpcClient"));

const canonicalRegisterRequest = (
  request: typeof RegistryApi.RegistryRegisterRequest.Type,
) =>
  RegistryApi.registryRegisterCodec.request.encode(request).pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Private serialization failure has one closed domain error at the RPC boundary.
    Effect.mapError(() => new InternalServerError()),
  );

const registerHandler =
  (input: {
    readonly storage: RegistryStorage;
    readonly registrySigningAuthority: AgentSigningAuthority;
  }) =>
  (request: typeof RegistryApi.RegistryRegisterRequest.Type) =>
    canonicalRegisterRequest(request).pipe(
      Effect.flatMap((requestBytes) =>
        input.storage.register({
          request,
          requestBytes,
          registrySigningAuthority: input.registrySigningAuthority,
        }),
      ),
    );

/**
 * Implements the three private operations over durable Registry storage.
 *
 * @param input Private RPC handler dependencies.
 * @param input.storage Durable Registry operations.
 * @param input.registrySigningAuthority Registry card issuer.
 * @returns A layer implementing the complete private operation group.
 */
export const makeRegistryRpcHandlersLayer = (input: {
  readonly storage: RegistryStorage;
  readonly registrySigningAuthority: AgentSigningAuthority;
}) =>
  registryOperations.toLayer({
    register: registerHandler(input),
    lookup: (request) => input.storage.lookup(request),
    list: (request) => input.storage.list(request),
  });
