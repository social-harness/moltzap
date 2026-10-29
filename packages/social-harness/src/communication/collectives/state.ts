/** @file Collective working state and its retained canonical descriptors. */
import { Effect, type Fiber, Schema } from "effect";
import type { CollectiveMemberOutcome } from "./inbound.js";
import type { CollectivePorts } from "./ports.js";
import type { ReceivedRequest } from "./received-request.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import { exactStruct } from "../../encoding/exact.js";
import { Content, PostId, RecordHash } from "../records/index.js";
import { AgentAddress, MessageAddressInput } from "../records/values.js";
import {
  type CollectiveOperationInput,
  decodeRuntimeValue,
  encodeRuntimeValue,
  type StoredCollectiveOperation,
} from "../store/index.js";
import {
  collectiveClosure,
  type CollectiveId,
  type CollectiveOperation,
  EpochMillis,
  type Members,
} from "./contracts.js";
import { FormModeSchema } from "./wire/index.js";

/** The requester retains its full fanout before any destination can bind. */
const localCollectiveDescriptor = exactStruct({
  op: Schema.Literal("gather", "all_gather"),
  to: MessageAddressInput,
  question: Schema.String,
  members: Schema.NonEmptyArray(AgentAddress),
  requestedSchema: FormModeSchema,
  content: Content,
  deadlineAt: EpochMillis,
  waitUntil: EpochMillis,
});

/** Finalization freezes certified references; certified history continues to own answer content. */
const collectiveSelection = Schema.Union(
  exactStruct({
    kind: Schema.Literal("result"),
    ...collectiveClosure.fields,
    answers: Schema.Array(
      exactStruct({ member: AgentAddress, recordHash: RecordHash }),
    ),
  }),
  exactStruct({
    kind: Schema.Literal("close"),
    ...collectiveClosure.fields,
    postId: PostId,
    included: Schema.Array(RecordHash),
  }),
  exactStruct({ kind: Schema.Literal("refused", "invalid-close") }),
);

/**
 * A gather or all_gather this endpoint started, before its deadline timer is
 * running. `answerHashes` holds the certified record of each counted answer,
 * which an all_gather's close lists.
 */
export interface GatherRequest {
  readonly op: Extract<
    CollectiveOperation,
    { readonly deadline: number }
  >["op"];
  readonly to: MessageAddressInput;
  readonly question: string;
  readonly members: Members;
  readonly requestedSchema: FormModeSchema;
  readonly outcomes: Map<AgentAddress, CollectiveMemberOutcome>;
  readonly answerHashes: Map<AgentAddress, RecordHash>;
}

/**
 * An operation this endpoint started that has not completed. `timer`
 * completes it at its deadline; completing it earlier interrupts the timer.
 */
export interface OpenGather extends GatherRequest {
  readonly deadlineAt: number;
  timer?: Fiber.RuntimeFiber<void>;
  requestsSettled: boolean;
}

/** Working projections rebuild from durable operations before host activation. */
export interface CollectiveState {
  readonly ports: CollectivePorts;
  /** Local answer admission and finalization cannot observe half a retained transition. */
  readonly transitions: Effect.Semaphore;
  readonly gathers: Map<CollectiveId, OpenGather>;
  readonly requests: Map<CollectiveId, ReceivedRequest>;
  /**
   * Operations that recorded `collective.opened` whose `collective.closed`
   * neither completion nor abandonment has claimed yet.
   */
  readonly announced: Set<CollectiveId>;
  readonly retained: Map<CollectiveId, StoredCollectiveOperation>;
  readonly counted: Map<CollectiveId, ReadonlyMap<AgentAddress, RecordHash>>;
  recovering: boolean;
}

/**
 * A validated gather ready to fan out: its state, the request content every
 * member receives, its absolute deadline, and the time its send stops
 * waiting for request posts.
 */
export interface PreparedGather {
  readonly id: CollectiveId;
  readonly open: GatherRequest;
  readonly content: typeof Content.Type;
  readonly deadlineAt: number;
  readonly waitUntil: number;
  readonly durable: CollectiveOperationInput;
}

/** Decode the requester's immutable descriptor before rebuilding its working state. */
export const readLocalCollective = (bytes: Uint8Array) =>
  decodeRuntimeValue(localCollectiveDescriptor, bytes);
/** Decode the frozen terminal selection before replaying certified answers. */
export const readCollectiveSelection = (bytes: Uint8Array) =>
  decodeRuntimeValue(collectiveSelection, bytes);

/** Encode the full requester decision before any request destination can bind. */
export function encodeLocalCollective(
  operationId: CollectiveId,
  descriptor: typeof localCollectiveDescriptor.Type,
) {
  return Effect.gen(function* () {
    return {
      operationId,
      origin: { kind: "local" },
      canonicalRequest: yield* encodeCanonical(Content, descriptor.content),
      canonicalDescriptor: yield* encodeRuntimeValue(descriptor),
    } satisfies CollectiveOperationInput;
  }).pipe(Effect.withSpan("encodeLocalCollective"));
}
