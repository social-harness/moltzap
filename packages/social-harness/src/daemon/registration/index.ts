/** @file Crash-recoverable daemon identity binding over Registry and endpoint storage. */

import { Data, Effect, Fiber, Schema } from "effect";
import type { StoreOpening } from "../../communication/store/index.js";
import type { HarnessMcpOperations } from "../mcp/index.js";
import type { VerifiedAgentCard } from "../../identity/cards.js";
import type {
  DaemonBootstrap,
  DaemonConfigurationError,
} from "../bootstrap.js";
import { exactParseOptions } from "../../encoding/exact.js";
import { registrationAdmissionRefusalMessage } from "../../host-protocol/index.js";
import {
  RegistryRegisterRequest,
  type RegistryRegisterResult,
} from "../../identity/registry/contract.js";
import { Registry } from "../../identity/registry/index.js";
import {
  bindCard,
  DaemonRegistrationPersistenceError,
  DaemonRegistrationRepresentationError,
  type DaemonRegistrationState,
  type DaemonRegistrationStore,
  readDaemonRegistrationState,
  representationFailure,
} from "./binding.js";

/**
 * The registration state read once at startup, its durable identity row
 * errors and the store authority registration needs.
 */
export {
  DaemonRegistrationPersistenceError,
  DaemonRegistrationRepresentationError,
  type DaemonRegistrationState,
  type DaemonRegistrationStore,
  readDaemonRegistrationState,
};

/** Registry transport or service failure without upstream implementation detail. */
export class DaemonRegistrationUpstreamError extends Data.TaggedError(
  "DaemonRegistrationUpstreamError",
) {}

/** A refused credential cannot succeed when the same request is retried. */
export class DaemonRegistrationRefusedError extends Data.TaggedError(
  "DaemonRegistrationRefusedError",
) {
  readonly reason = "admission-refused";
  /**
   * The operator remedy contains no credential or upstream implementation detail.
   * @returns The final refusal and the credential replacement instructions.
   */
  override get message(): string {
    return registrationAdmissionRefusalMessage;
  }
}

type RegistrationRequest = Parameters<HarnessMcpOperations["register"]>[0];

const upstreamFailure = (): DaemonRegistrationUpstreamError =>
  new DaemonRegistrationUpstreamError();

/**
 * Loads the admission credential only while the daemon is unregistered, so an
 * unregistered daemon fails closed without it and a registered daemon starts
 * without reading it.
 *
 * @param state The registration state read once at startup.
 * @param bootstrap Configured deferred admission credential.
 * @returns Nothing once startup admission is satisfied.
 */
export const requireAdmission = (
  state: DaemonRegistrationState,
  bootstrap: DaemonBootstrap,
): Effect.Effect<void, DaemonConfigurationError> =>
  (state.kind === "unregistered"
    ? Effect.asVoid(bootstrap.admissionCredential)
    : Effect.void
  ).pipe(Effect.withSpan("requireAdmission"));

/**
 * Loads the admission credential before creating an unregistered store, so a
 * daemon that cannot register fails before it touches the state directory.
 *
 * @param opening How the state directory's store will open.
 * @param bootstrap Configured deferred admission credential.
 * @returns Nothing once the store may be opened.
 */
export const requireAdmissionToCreate = (
  opening: StoreOpening,
  bootstrap: DaemonBootstrap,
): Effect.Effect<void, DaemonConfigurationError> =>
  (opening === "create"
    ? Effect.asVoid(bootstrap.admissionCredential)
    : Effect.void
  ).pipe(Effect.withSpan("requireAdmissionToCreate"));

const makeRegistryRequest = (input: {
  readonly request: RegistrationRequest;
  readonly bootstrap: DaemonBootstrap;
}) =>
  Schema.decodeUnknown(RegistryRegisterRequest)(
    {
      operationId: input.request.operationId,
      principalId: input.request.principalId,
      agentName: input.request.agentName,
      publicKey: input.bootstrap.agentPublicKey,
    },
    exactParseOptions,
  ).pipe(Effect.mapError(representationFailure));

const registrationMatches = (
  agentCard: VerifiedAgentCard,
  request: RegistrationRequest,
  bootstrap: DaemonBootstrap,
): boolean =>
  agentCard.principalId === request.principalId &&
  agentCard.agentName === request.agentName &&
  agentCard.publicKey.x === bootstrap.agentPublicKey.x;

/**
 * The Registry call, run detached and interruptible. Detached, it is not a
 * child of its caller, so an interrupt sent to the caller does not reach it:
 * Effect interrupts a fiber's children even inside an uninterruptible region.
 * Interruptible, it ends at the Registry client's own deadline while an
 * uninterruptible caller waits on the join.
 *
 * @param call The registration request, its admission credential and the
 *   agent signing authority that signs it.
 * @returns The Registry's result, or its failure, once the detached call ends.
 */
const registerWithRegistry = (
  call: Parameters<typeof Registry.register>[0],
): ReturnType<typeof Registry.register> =>
  Effect.forkDaemon(Effect.interruptible(Registry.register(call))).pipe(
    Effect.flatMap(Fiber.join),
  );

/**
 * Registers through Identity and commits a successful binding before return.
 * Only a `registered` result carries the verified card; the Registry's refusals
 * pass through unchanged and bind nothing. The Registry call ends at its own
 * deadline even when the caller is uninterruptible, and a caller's cancellation
 * does not stop it. The binding follows a cancelled call only when the caller
 * runs this uninterruptibly, as the register tool does.
 *
 * @param input Complete registration dependencies.
 * @param input.request Closed caller-supplied registration fields.
 * @param input.store Minimal durable identity store.
 * @param input.bootstrap Configured public key, signer, and deferred admission
 *   credential, whose load failure refuses registration before Registry is called.
 * @returns The exact Registry result after any successful binding is durable.
 */
export const registerDaemonIdentity = (input: {
  readonly request: RegistrationRequest;
  readonly store: DaemonRegistrationStore;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<
  RegistryRegisterResult,
  | DaemonRegistrationUpstreamError
  | DaemonRegistrationRefusedError
  | DaemonRegistrationPersistenceError
  | DaemonRegistrationRepresentationError
  | DaemonConfigurationError,
  Registry
> =>
  Effect.gen(function* () {
    const request = yield* makeRegistryRequest(input);
    const admissionCredential = yield* input.bootstrap.admissionCredential;
    const result = yield* registerWithRegistry({
      request,
      admissionCredential,
      signingAuthority: input.bootstrap.signingAuthority,
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "AuthenticationFailedError"
          ? new DaemonRegistrationRefusedError()
          : upstreamFailure(),
      ),
    );
    if (result.kind === "registered") {
      if (
        !registrationMatches(result.agentCard, input.request, input.bootstrap)
      ) {
        return yield* representationFailure();
      }
      yield* bindCard(input.store, result.agentCard);
    }
    return result;
  }).pipe(Effect.withSpan("registerDaemonIdentity"));
