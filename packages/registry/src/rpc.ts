/** @file Private admitted Registry operations and in-process RPC dispatch. */

import type { AgentSigningAuthority } from "@moltzap/social-harness";
import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcMiddleware,
  RpcServer,
} from "@effect/rpc";
import { httpErrors, registryContract } from "@moltzap/social-harness/internal";
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
import type { RegistryStorage } from "./storage.js";

/* eslint-disable @typescript-eslint/naming-convention -- Closed HTTP error constructors retain their class names when bound from the service capability. */
const { AuthenticationFailedError, InternalServerError } = httpErrors;
/* eslint-enable @typescript-eslint/naming-convention -- Restore variable naming after binding error constructors. */

interface BootstrapAdmission {
  readonly admitted: true;
}

class BootstrapAdmissionContext extends Context.Tag(
  "@moltzap/social-harness/BootstrapAdmissionContext",
)<BootstrapAdmissionContext, BootstrapAdmission>() {}

const registryAdmissionTag: RpcMiddleware.TagClass<
  RegistryAdmission,
  "@moltzap/social-harness/RegistryAdmission",
  {
    readonly provides: typeof BootstrapAdmissionContext;
    readonly failure: typeof httpErrors.AuthenticationFailedError;
  }
> = RpcMiddleware.Tag<RegistryAdmission>()(
  "@moltzap/social-harness/RegistryAdmission",
  {
    provides: BootstrapAdmissionContext,
    failure: httpErrors.AuthenticationFailedError,
  },
);

/** Required private RPC admission boundary for Registry registration. */
export class RegistryAdmission extends registryAdmissionTag {}

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

const registerErrors: Schema.Schema<
  InstanceType<(typeof httpErrors)[keyof typeof httpErrors]>,
  Schema.Schema.Encoded<(typeof httpErrors)[keyof typeof httpErrors]>
> = Schema.Union(
  httpErrors.MalformedRequestError,
  httpErrors.AuthenticationFailedError,
  httpErrors.RouteNotFoundError,
  httpErrors.MethodNotAllowedError,
  httpErrors.VersionMismatchError,
  httpErrors.PayloadTooLargeError,
  httpErrors.UnsupportedMediaTypeError,
  httpErrors.OverloadedError,
  httpErrors.UnavailableError,
  httpErrors.InternalServerError,
);

const publicReadErrors: Schema.Schema<
  Exclude<
    InstanceType<(typeof httpErrors)[keyof typeof httpErrors]>,
    InstanceType<typeof httpErrors.AuthenticationFailedError>
  >,
  Schema.Schema.Encoded<
    Exclude<
      (typeof httpErrors)[keyof typeof httpErrors],
      typeof httpErrors.AuthenticationFailedError
    >
  >
> = Schema.Union(
  httpErrors.MalformedRequestError,
  httpErrors.RouteNotFoundError,
  httpErrors.MethodNotAllowedError,
  httpErrors.VersionMismatchError,
  httpErrors.PayloadTooLargeError,
  httpErrors.UnsupportedMediaTypeError,
  httpErrors.OverloadedError,
  httpErrors.UnavailableError,
  httpErrors.InternalServerError,
);

/** Private registration operation including its admission middleware. */
const registerOperation: Rpc.Rpc<
  "register",
  typeof registryContract.RegistryRegisterRequest,
  typeof registryContract.registerResultSchema,
  typeof registerErrors,
  typeof RegistryAdmission
> = Rpc.make("register", {
  payload: registryContract.RegistryRegisterRequest,
  success: registryContract.registerResultSchema,
  error: registerErrors,
}).middleware(RegistryAdmission);

/** Private lookup operation. */
const lookupOperation: Rpc.Rpc<
  "lookup",
  typeof registryContract.RegistryLookupRequest,
  typeof registryContract.lookupResultSchema,
  typeof publicReadErrors
> = Rpc.make("lookup", {
  payload: registryContract.RegistryLookupRequest,
  success: registryContract.lookupResultSchema,
  error: publicReadErrors,
});

/** The package-private no-serialization Registry operation group. */
const registryOperations: RpcGroup.RpcGroup<
  typeof registerOperation | typeof lookupOperation
> = RpcGroup.make(registerOperation, lookupOperation);

/** Private in-process client for the Registry operation group. */
export type RegistryRpcClient = RpcClient.FromGroup<typeof registryOperations>;

type NoSerializationClient = Effect.Effect.Success<
  ReturnType<
    typeof RpcClient.makeNoSerialization<
      typeof registerOperation | typeof lookupOperation,
      never
    >
  >
>;

/** Connects the private Registry RPC client and server in memory. */
export const makeRegistryRpcClient: Effect.Effect<
  RegistryRpcClient,
  never,
  | Scope.Scope
  | Rpc.ToHandler<RpcGroup.Rpcs<typeof registryOperations>>
  | RegistryAdmission
> = Effect.gen(function* () {
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
  request: typeof registryContract.RegistryRegisterRequest.Type,
) =>
  registryContract.registryRegisterCodec.request.encode(request).pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Private serialization failure has one closed domain error at the RPC boundary.
    Effect.mapError(() => new InternalServerError()),
  );

const registerHandler =
  (input: {
    readonly storage: RegistryStorage;
    readonly registrySigningAuthority: AgentSigningAuthority;
  }) =>
  (request: typeof registryContract.RegistryRegisterRequest.Type) =>
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
 * Implements registration and lookup over durable Registry storage.
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
  });
