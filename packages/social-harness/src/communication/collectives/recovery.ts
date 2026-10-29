/** @file Rebuild collective working state from retained decisions and certified history. */
import { Clock, Effect, Fiber, Schema } from "effect";
import type { CollectiveOperations, PostSender } from "./ports.js";
import type { OpenRequest, ReceivedRequest } from "./received-request.js";
import type { HeldClose } from "./shared-answers.js";
import { InboundMessage } from "../conversations/message.js";
import { AgentAddress, RecordHash } from "../records/index.js";
import {
  type CollectiveRequestRefusal,
  decodeRuntimeValue,
  EndpointStoreError,
  type StoredCollectiveOperation,
  type StoredCollectivePost,
} from "../store/index.js";
import {
  type CollectiveEmitError,
  type CollectiveError,
  CollectiveId,
} from "./contracts.js";
import {
  postRefusal,
  type RequestRefusal,
  sleepUntil,
} from "./request-sends.js";
import {
  type CollectiveState,
  type PreparedGather,
  readCollectiveSelection,
  readLocalCollective,
} from "./state.js";

/** Recovery invokes the same transitions used by live delivery and certification. */
export interface RecoveryActions {
  readonly open: (
    prepared: PreparedGather,
  ) => Effect.Effect<void, CollectiveError>;
  readonly classify: CollectiveOperations["classify"];
  readonly restoreResponse: (
    post: StoredCollectivePost,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly close: (
    asked: OpenRequest<
      Extract<ReceivedRequest, { readonly kind: "all_gather" }>
    >,
    close: HeldClose,
  ) => Effect.Effect<void, CollectiveEmitError>;
  readonly complete: (
    id: CollectiveId,
  ) => Effect.Effect<void, CollectiveEmitError>;
  readonly refuse: (
    id: CollectiveId,
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
      const id = yield* storedValue(CollectiveId, operation.operationId);
      state.retained.set(id, operation);
    }
    yield* restoreCountedAnswers(state);
    const prepared = yield* restoreOperations(state, actions);
    const posts = yield* state.ports.store.readCollectivePosts();
    const refusals = yield* state.ports.store.readCollectiveRefusals();
    const claims = claimedRequestDestinations(posts, refusals);
    yield* replayDeliveries(state, actions, posts);
    yield* restoreRefusals(state, refusals);
    yield* Effect.sync(() => {
      state.recovering = false;
    });
    yield* resumeHeldCloses(state, actions);
    yield* Effect.forEach(
      [...prepared],
      ([id, operation]) =>
        resumeRequester(state, actions, {
          id,
          operation,
          claimed: claims.get(id) ?? new Set(),
        }),
      { concurrency: 1, discard: true },
    );
  }).pipe(Effect.withSpan("recoverCollectives"));
}

/** Remote context appears at its original delivery, so an earlier consumed close stays unknown. */
function replayDeliveries(
  state: CollectiveState,
  actions: RecoveryActions,
  posts: readonly StoredCollectivePost[],
) {
  const requests = new Map(
    [...state.retained.values()].flatMap((operation) =>
      operation.origin.kind === "remote"
        ? [[operation.origin.recordHash, operation] as const]
        : [],
    ),
  );
  const responses = new Map(
    posts
      .filter((post) => post.role === "response")
      .map((post) => [post.operationId, post]),
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
            yield* restoreRemote(state, request);
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
  posts: readonly StoredCollectivePost[],
  refusals: readonly CollectiveRequestRefusal[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const claims = new Map<string, Set<string>>();
  const requests = posts.filter((post) => post.role === "request");
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
      const id = yield* storedValue(CollectiveId, reference.operationId);
      const member = yield* storedValue(AgentAddress, reference.member);
      const hash = yield* storedValue(RecordHash, reference.recordHash);
      state.counted.set(
        id,
        new Map([...(state.counted.get(id) ?? []), [member, hash]]),
      );
    }
  });
}

function restoreOperations(state: CollectiveState, actions: RecoveryActions) {
  return Effect.gen(function* () {
    const prepared = new Map<CollectiveId, PreparedGather>();
    for (const [id, retained] of state.retained) {
      if (retained.phase === "completed") {
        continue;
      }
      if (retained.origin.kind === "local") {
        const operation = yield* restoreLocal(state, id, retained);
        prepared.set(id, operation);
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
  id: CollectiveId,
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
        id,
        new Map(
          selection.answers.map(({ member, recordHash }) => [
            member,
            recordHash,
          ]),
        ),
      );
    }
    const descriptor = yield* readLocalCollective(retained.canonicalDescriptor);
    return {
      id,
      open: { ...descriptor, outcomes: new Map(), answerHashes: new Map() },
      content: descriptor.content,
      deadlineAt: descriptor.deadlineAt,
      waitUntil: descriptor.waitUntil,
      durable: retained,
    } satisfies PreparedGather;
  });
}

function restoreRemote(
  state: CollectiveState,
  retained: StoredCollectiveOperation,
) {
  return Effect.gen(function* () {
    if (retained.origin.kind !== "remote") {
      return;
    }
    const id = yield* storedValue(CollectiveId, retained.operationId);
    const request = state.requests.get(id);
    if (request === undefined || !retained.origin.requiresAdmission) {
      return;
    }
    const admission = yield* state.ports.store.readFirewallRequestAdmission(
      retained.origin.recordHash,
    );
    if (admission?.presented) {
      request.state = "open";
    } else {
      request.state =
        admission?.checkId === undefined ? "unadmitted" : "withheld";
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
      const id = yield* storedValue(CollectiveId, refusal.operationId);
      const member = yield* storedValue(AgentAddress, refusal.destination);
      state.gathers.get(id)?.outcomes.set(member, { kind: "no-answer" });
    }
  });
}

function resumeHeldCloses(state: CollectiveState, actions: RecoveryActions) {
  return Effect.gen(function* () {
    for (const [id, request] of state.requests) {
      if (
        request.kind !== "all_gather" ||
        request.shared.heldClose === undefined
      ) {
        continue;
      }
      const close = request.shared.heldClose;
      request.shared.heldClose = undefined;
      yield* actions
        .close({ id, request }, close)
        .pipe(Effect.catchTag("CollectiveEmitError", persistenceFailure));
    }
  });
}

interface RecoveredRequester {
  readonly id: CollectiveId;
  readonly operation: PreparedGather;
  readonly claimed: ReadonlySet<string>;
}

function resumeRequester(
  state: CollectiveState,
  actions: RecoveryActions,
  recovered: RecoveredRequester,
) {
  return Effect.gen(function* () {
    const { id, operation } = recovered;
    const open = state.gathers.get(id);
    if (open === undefined) {
      return;
    }
    if (open.timer !== undefined) {
      yield* Fiber.interrupt(open.timer);
    }
    const retained = state.retained.get(id);
    const ready =
      open.outcomes.size === open.members.length ||
      (yield* Clock.currentTimeMillis) >= operation.deadlineAt;
    if (retained?.phase === "finalizing" || ready) {
      return yield* actions
        .complete(id)
        .pipe(Effect.catchTag("CollectiveEmitError", persistenceFailure));
    }
    const timer = yield* sleepUntil(operation.deadlineAt).pipe(
      Effect.zipRight(Effect.ignore(actions.complete(id))),
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
  const { id, operation, claimed } = recovered;
  const checkId = state.retained.get(id)?.admittedCheckId;
  const send: PostSender =
    checkId === undefined
      ? state.ports.sendPost
      : (input) => state.ports.sendAdmitted(input, checkId);
  const pending = operation.open.members.filter(
    (member) => !claimed.has(member),
  );
  return Effect.forEach(
    pending,
    (member) =>
      send({
        to: member,
        content: operation.content,
        collective: { operationId: id, role: "request", destination: member },
      }).pipe(
        Effect.catchAll((error) =>
          actions.refuse(id, postRefusal(member, error)),
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
