/** @file Rebuild collective working state from retained decisions and certified history. */
import { Clock, Effect, Fiber, Option, Schema } from "effect";
import type { MessageClassifier } from "./ports.js";
import type { OpenRequest, ReceivedRequest } from "./received-request.js";
import type { HeldClose } from "./shared-answers.js";
import { AgentCard, AgentView } from "../../identity/cards.js";
import { preparedSendData } from "../conversations/index.js";
import { InboundMessage } from "../conversations/message.js";
import { AgentAddress, Content, RecordHash } from "../records/index.js";
import {
  type CollectiveRequestRefusal,
  decodeRuntimeValue,
  EndpointStoreError,
  type StoredCollectiveMessage,
  type StoredCollectiveOperation,
} from "../store/index.js";
import {
  type CollectiveEmitError,
  type CollectiveError,
  CollectiveId,
} from "./contracts.js";
import {
  messageRefusal,
  type RequestRefusal,
  sleepUntil,
} from "./request-sends.js";
import {
  type CollectiveState,
  type PreparedGather,
  readCollectiveSelection,
  readLocalCollective,
} from "./state.js";
import {
  collectiveRequesterOf,
  type CollectiveValue,
  readCollectiveValue,
} from "./wire/index.js";

/** Recovery invokes the same transitions used by live delivery and certification. */
export interface RecoveryActions {
  readonly open: (
    prepared: PreparedGather,
  ) => Effect.Effect<void, CollectiveError>;
  readonly classify: MessageClassifier;
  readonly restoreResponse: (
    message: StoredCollectiveMessage,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly close: (
    asked: OpenRequest<
      Extract<ReceivedRequest, { readonly kind: "all_gather" }>
    >,
    close: HeldClose,
  ) => Effect.Effect<void, CollectiveEmitError>;
  readonly complete: (
    operationId: CollectiveId,
  ) => Effect.Effect<void, CollectiveEmitError>;
  readonly refuse: (
    operationId: CollectiveId,
    refusal: RequestRefusal,
  ) => Effect.Effect<void>;
}

/** Recover decisions before deadlines, close processing, or host sends resume. */
export function recoverCollectives(
  state: CollectiveState,
  actions: RecoveryActions,
): Effect.Effect<void, EndpointStoreError> {
  return Effect.gen(function* () {
    const operations = yield* state.ports.store.readCollectiveOperations();
    for (const operation of operations) {
      const operationId = yield* storedValue(
        CollectiveId,
        operation.operationId,
      );
      const requester = collectiveRequesterOf(operationId);
      if (
        requester !== operation.creatorAgentId ||
        (operation.origin.kind === "local" &&
          requester !== state.ports.self.agentId)
      ) {
        return yield* corruptState();
      }
      state.retained.set(operationId, operation);
    }
    yield* restoreCountedAnswers(state);
    const prepared = yield* restoreOperations(state, actions);
    const messages = yield* state.ports.store.readCollectiveMessages();
    const refusals = yield* state.ports.store.readCollectiveRefusals();
    const claims = claimedRequestDestinations(messages, refusals);
    yield* replayDeliveries(state, actions, messages);
    yield* restoreRefusals(state, refusals);
    yield* Effect.sync(() => {
      state.recovering = false;
    });
    yield* resumeHeldCloses(state, actions);
    yield* Effect.forEach(
      [...prepared],
      ([operationId, operation]) =>
        resumeRequester(state, actions, {
          operationId,
          operation,
          claimed: claims.get(operationId) ?? new Set(),
        }),
      { concurrency: 1, discard: true },
    );
  }).pipe(Effect.withSpan("recoverCollectives"));
}

/** Remote context appears at its original delivery, so an earlier consumed close stays unknown. */
function replayDeliveries(
  state: CollectiveState,
  actions: RecoveryActions,
  messages: readonly StoredCollectiveMessage[],
) {
  const requests = new Map(
    [...state.retained.values()].flatMap((operation) =>
      operation.origin.kind === "remote"
        ? [[operation.origin.recordHash, operation] as const]
        : [],
    ),
  );
  const responses = new Map(
    messages
      .filter((message) => message.role === "response")
      .map((message) => [message.operationId, message]),
  );
  return state.ports.store.readRetainedDeliveries().pipe(
    Effect.flatMap((deliveries) =>
      Effect.forEach(
        deliveries,
        (delivery) =>
          Effect.gen(function* () {
            yield* replayMessage(
              actions,
              delivery.canonicalMessage,
              delivery.recordHash,
            );
            const request = requests.get(delivery.recordHash);
            if (request === undefined) {
              return;
            }
            const response = responses.get(request.operationId);
            if (response !== undefined) {
              yield* actions.restoreResponse(response);
            }
          }),
        { concurrency: 1, discard: true },
      ),
    ),
  );
}

/** One recovery pass indexes bound and refused destinations before active fanouts resume. */
function claimedRequestDestinations(
  messages: readonly StoredCollectiveMessage[],
  refusals: readonly CollectiveRequestRefusal[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const claims = new Map<string, Set<string>>();
  const requests = messages.filter((message) => message.role === "request");
  for (const claim of [...requests, ...refusals]) {
    const destinations = claims.get(claim.operationId) ?? new Set<string>();
    destinations.add(claim.destination);
    claims.set(claim.operationId, destinations);
  }
  return claims;
}

function restoreCountedAnswers(state: CollectiveState) {
  return Effect.gen(function* () {
    const answers = yield* state.ports.store.readCollectiveAnswers();
    for (const reference of answers) {
      const operationId = yield* storedValue(
        CollectiveId,
        reference.operationId,
      );
      const member = yield* storedValue(AgentAddress, reference.member);
      const hash = yield* storedValue(RecordHash, reference.recordHash);
      state.counted.set(
        operationId,
        new Map([...(state.counted.get(operationId) ?? []), [member, hash]]),
      );
    }
  });
}

function restoreOperations(state: CollectiveState, actions: RecoveryActions) {
  return Effect.gen(function* () {
    const prepared = new Map<CollectiveId, PreparedGather>();
    for (const [operationId, retained] of state.retained) {
      if (retained.phase === "completed") {
        continue;
      }
      if (retained.origin.kind === "local") {
        const operation = yield* restoreLocal(state, operationId, retained);
        prepared.set(operationId, operation);
        yield* actions
          .open(operation)
          .pipe(Effect.catchTag("CollectiveError", corruptState));
      }
    }
    return prepared;
  });
}

function restoreLocal(
  state: CollectiveState,
  operationId: CollectiveId,
  retained: StoredCollectiveOperation,
) {
  return Effect.gen(function* () {
    if (retained.canonicalSelection !== undefined) {
      const selection = yield* readCollectiveSelection(
        retained.canonicalSelection,
      );
      if (selection.kind !== "result") {
        return yield* new EndpointStoreError({ reason: "corrupt" });
      }
      state.counted.set(
        operationId,
        new Map(
          selection.answers.map(({ member, recordHash }) => [
            member,
            recordHash,
          ]),
        ),
      );
    }
    const descriptor = yield* readLocalCollective(retained.canonicalDescriptor);
    const value = yield* readCollectiveValue(descriptor.content).pipe(
      Effect.catchTag("CollectivePartInvalidError", corruptState),
    );
    if (
      Option.isNone(value) ||
      value.value.kind !== "operation" ||
      value.value.op === "multicast" ||
      !matchesRetainedOperation(value.value, operationId, descriptor)
    ) {
      return yield* corruptState();
    }
    yield* validatePreparedRequests(state, descriptor);
    return {
      operationId,
      open: { ...descriptor, outcomes: new Map(), answerHashes: new Map() },
      content: descriptor.content,
      deadlineAt: descriptor.deadlineAt,
      waitUntil: descriptor.waitUntil,
      durable: retained,
      requests: descriptor.requests,
    } satisfies PreparedGather;
  });
}

function matchesRetainedOperation(
  value: Extract<
    CollectiveValue,
    { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
  >,
  operationId: CollectiveId,
  descriptor: Effect.Effect.Success<ReturnType<typeof readLocalCollective>>,
) {
  return (
    value.operationId === operationId &&
    value.op === descriptor.op &&
    value.deadlineAt === descriptor.deadlineAt
  );
}

/** Retained fanout preparations must still name the descriptor's exact content, author and peers. */
function validatePreparedRequests(
  state: CollectiveState,
  descriptor: Effect.Effect.Success<ReturnType<typeof readLocalCollective>>,
) {
  const destinations =
    descriptor.op === "gather"
      ? descriptor.members.map((member) => `agent:${member.agentName}`)
      : [descriptor.to];
  if (
    descriptor.requests.length !== destinations.length ||
    new Set(descriptor.requests.map(({ to }) => to)).size !==
      destinations.length ||
    descriptor.requests.some(({ to }) => !destinations.includes(to))
  ) {
    return corruptState();
  }
  return Effect.forEach(
    descriptor.requests,
    (request) => validatePreparedRequest(state, descriptor, request),
    { concurrency: 1, discard: true },
  );
}

function validatePreparedRequest(
  state: CollectiveState,
  descriptor: Effect.Effect.Success<ReturnType<typeof readLocalCollective>>,
  request: PreparedGather["requests"][number],
) {
  return Effect.gen(function* () {
    const { intent, descriptor: membership } = yield* preparedSendData(
      request.message,
    ).pipe(Effect.catchTag("SendError", corruptState));
    const cards = yield* Effect.forEach(
      membership.members,
      (card) =>
        Schema.decodeUnknown(AgentCard)(card).pipe(
          Effect.catchTag("ParseError", corruptState),
        ),
      { concurrency: 1 },
    );
    const members = [
      state.ports.self,
      ...descriptor.members.filter(
        (member) =>
          descriptor.op === "all_gather" ||
          `agent:${member.agentName}` === request.to,
      ),
    ];
    if (
      intent.authorAgentId !== state.ports.self.agentId ||
      !Schema.equivalence(Content)(intent.content, descriptor.content) ||
      cards.length !== members.length ||
      cards.some(
        (card) =>
          !members.some((member) =>
            Schema.equivalence(AgentView)(AgentView.make(card), member),
          ),
      )
    ) {
      return yield* corruptState();
    }
  });
}

function replayMessage(
  actions: RecoveryActions,
  canonicalMessage: Uint8Array,
  hash: string,
) {
  return Effect.gen(function* () {
    const message = yield* decodeRuntimeValue(InboundMessage, canonicalMessage);
    const recordHash = yield* storedValue(RecordHash, hash);
    yield* actions
      .classify({ message, recordHash })
      .pipe(Effect.catchTag("CollectiveEmitError", persistenceFailure));
  });
}

function restoreRefusals(
  state: CollectiveState,
  refusals: readonly CollectiveRequestRefusal[],
) {
  return Effect.gen(function* () {
    for (const refusal of refusals) {
      const operationId = yield* storedValue(CollectiveId, refusal.operationId);
      const member = yield* storedValue(AgentAddress, refusal.destination);
      state.gathers
        .get(operationId)
        ?.outcomes.set(member, { kind: "no-answer" });
    }
  });
}

function resumeHeldCloses(state: CollectiveState, actions: RecoveryActions) {
  return Effect.gen(function* () {
    for (const [operationId, request] of state.requests) {
      if (
        request.kind !== "all_gather" ||
        request.shared.heldClose === undefined
      ) {
        continue;
      }
      const close = request.shared.heldClose;
      request.shared.heldClose = undefined;
      yield* actions
        .close({ operationId, request }, close)
        .pipe(Effect.catchTag("CollectiveEmitError", persistenceFailure));
    }
  });
}

interface RecoveredRequester {
  readonly operationId: CollectiveId;
  readonly operation: PreparedGather;
  readonly claimed: ReadonlySet<string>;
}

function resumeRequester(
  state: CollectiveState,
  actions: RecoveryActions,
  recovered: RecoveredRequester,
) {
  return Effect.gen(function* () {
    const { operationId, operation } = recovered;
    const open = state.gathers.get(operationId);
    if (open === undefined) {
      return;
    }
    if (open.timer !== undefined) {
      yield* Fiber.interrupt(open.timer);
    }
    const retained = state.retained.get(operationId);
    const ready =
      open.outcomes.size === open.members.length ||
      (yield* Clock.currentTimeMillis) >= operation.deadlineAt;
    if (retained?.phase === "finalizing" || ready) {
      return yield* actions
        .complete(operationId)
        .pipe(Effect.catchTag("CollectiveEmitError", persistenceFailure));
    }
    const timer = yield* sleepUntil(operation.deadlineAt).pipe(
      Effect.zipRight(Effect.ignore(actions.complete(operationId))),
      Effect.interruptible,
      Effect.forkIn(state.ports.scope),
    );
    open.timer = timer;
    if (open.op === "gather") {
      yield* resumeFanout(state, actions, recovered);
    }
  });
}

function resumeFanout(
  state: CollectiveState,
  actions: RecoveryActions,
  recovered: RecoveredRequester,
) {
  const { operationId, operation, claimed } = recovered;
  const pending = operation.requests.filter(({ to }) => !claimed.has(to));
  return Effect.forEach(
    pending,
    ({ to, message }) =>
      state.ports
        .acceptMessage(
          {
            ...message,
            collective: { operationId, role: "request", destination: to },
          },
          Effect.succeed(Effect.void),
        )
        .pipe(
          Effect.flatMap(({ certified }) => certified),
          Effect.catchAll((error) =>
            actions.refuse(
              operationId,
              messageRefusal(Schema.decodeUnknownSync(AgentAddress)(to), error),
            ),
          ),
          Effect.forkIn(state.ports.scope),
        ),
    { concurrency: 1, discard: true },
  );
}

function storedValue<A, I>(schema: Schema.Schema<A, I>, value: unknown) {
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.catchTag("ParseError", corruptState),
  );
}

function corruptState() {
  return Effect.fail(new EndpointStoreError({ reason: "corrupt" }));
}

function persistenceFailure() {
  return Effect.fail(new EndpointStoreError({ reason: "persistence" }));
}
