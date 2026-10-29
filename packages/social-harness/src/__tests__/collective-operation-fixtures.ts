/** @file Recording ports, post builders and send helpers shared by the collective operation tests. */

import { testAgentView } from "./agent-card-fixtures.js";
import { Duration, Effect, Schema, type Scope } from "effect";
import type { InboundItem } from "../communication/collectives/inbound.js";
import type {
  CollectiveAdmission,
  CollectiveOperations,
  CollectivePorts,
} from "../communication/collectives/ports.js";
import type { EngineSendInput } from "../communication/conversations/index.js";
import type { FirewallSendError } from "../firewall/outcome/index.js";
import {
  CollectiveEmitError,
  CollectiveError,
  type CollectiveId,
  SendInput,
} from "../communication/collectives/contracts.js";
import { makeCollectiveOperations } from "../communication/collectives/index.js";
import {
  collectiveIdOf,
  readCollectiveValue,
} from "../communication/collectives/wire/index.js";
import { SendError } from "../communication/conversations/errors.js";
import { InboundMessage } from "../communication/conversations/message.js";
import { PostId, RecordHash } from "../communication/records/index.js";
import { AgentAddress } from "../communication/records/values.js";
import { digest } from "./agent-card-fixtures.js";
import { collectivePersistencePorts } from "./collective-storage-stub.js";

/** The agent a layer `makeLayer` builds runs as unless told otherwise. */
export const alice = Schema.decodeUnknownSync(AgentAddress)("agent:alice");

const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");

/** The data-part key a post carries its collective value under. */
export const collectiveKey = "org.social-harness/collective";

/** The explicit collective part every multicast an endpoint authors carries. */
export const multicastPart = {
  type: "data",
  value: { [collectiveKey]: { kind: "operation", op: "multicast" } },
};

/** A form-mode schema asking for one required `slot`, `mon` or `tue`. */
export const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
};

/** The nonce Bob's gather request carries. */
export const requestNonce = "N".repeat(43);

/** The id Bob's gather request derives from `requestNonce`, so it names Bob as its requester. */
export const requestId = collectiveIdOf(bob, requestNonce);

/** The question every gather and all_gather in these tests asks. */
export const questionText = "Which day works?";

/** The canonical address of the group a gather asks: alice, Bob and Carol. */
export const gatherTo = "group:alice,bob,carol";

/**
 * A record hash whose 32 bytes are all `byte`.
 * @param byte The repeated byte.
 * @returns The decoded RecordHash.
 */
export const recordHashOf = (byte: number) =>
  Schema.decodeUnknownSync(RecordHash)(digest("rch_", byte));

/** The record hash every post `classifyPost` classifies carries. */
const recordHash = recordHashOf(0);

/** What a layer's ports saw: the posts it certified and the items it emitted, in order. */
export interface Observed {
  readonly sent: EngineSendInput[];
  readonly emitted: InboundItem[];
}

/**
 * A PostId whose 32 bytes are all `byte`.
 * @param byte The repeated byte.
 * @returns The decoded PostId.
 */
export const postId = (byte: number) =>
  Schema.decodeUnknownSync(PostId)(digest("pst_", byte));

/**
 * A recorder that has seen nothing yet.
 * @returns Empty sent and emitted lists.
 */
export const newObserved = (): Observed => ({ sent: [], emitted: [] });

/**
 * An emit port that keeps nothing, as a service whose store refuses every item.
 * @returns A failure naming the unkept item.
 */
export const unkeptEmit = () => Effect.fail(new CollectiveEmitError());

/**
 * Record a post and certify it as the engine does, under its own PostId and
 * record hash: the nth post recorded gets byte `100 + n` for both, so neither
 * collides with the bytes below 100 a test gives the posts it classifies.
 * @param observed Where the post is recorded.
 * @param input The post being certified.
 * @returns The certified post's PostId and record hash.
 */
export const certifyNext = (observed: Observed, input: EngineSendInput) =>
  Effect.sync(() => {
    observed.sent.push({ to: input.to, content: input.content });
    const byte = 100 + observed.sent.length;
    return { postId: postId(byte), recordHash: recordHashOf(byte) };
  });

/**
 * The send's wait for its request posts, mirroring the private
 * `request-sends.ts → REQUEST_SEND_WAIT`. Tests advance the test clock by it to
 * end that wait, so a change to the production bound is made here too.
 */
export const requestSendWait = Duration.seconds(20);

/** How long after the send's wait ends a `late` post certifies. */
export const latePostDelay = Duration.seconds(5);

/** What a test layer varies from ports that resolve, certify and keep everything. */
interface LayerOptions {
  /** The agent the layer runs as, `alice` by default. */
  readonly self?: string;
  /**
   * Addresses whose post is not passed to `sendPost` at once: refused with the
   * reason given, held forever for `slow`, or passed on `latePostDelay` after
   * the send's `requestSendWait` ends for `late`.
   */
  readonly refused?: Readonly<
    Record<string, SendError["reason"] | "slow" | "late">
  >;
  /** Members whose lookup fails as an unknown agent. */
  readonly unknown?: readonly string[];
  /** Certifies each post `refused` lets through; `certifyNext` by default. */
  readonly sendPost?: CollectivePorts["sendPost"];
  /** Keeps each item the layer emits; by default it records the item. */
  readonly emit?: CollectivePorts["emit"];
  /** An installed firewall's checks; none by default. */
  readonly admission?: CollectiveAdmission;
}

/**
 * A collective layer over recording ports in the caller's scope. Its send
 * waits `requestSendWait` for request posts, so a test that needs that wait
 * to end advances the test clock by it.
 * @param observed Where the default ports record certified posts and emitted items.
 * @param options The agent the layer runs as, and the ports that differ from the recording defaults.
 * @param options.self The agent the layer runs as, `alice` by default.
 * @param options.refused Addresses whose post does not certify at once, and how it fares.
 * @param options.unknown Members whose lookup fails as an unknown agent.
 * @param options.sendPost Certifies each post `refused` lets through.
 * @param options.emit Keeps each item the layer emits.
 * @param options.admission An installed firewall's checks.
 * @returns The layer, scoped to the caller.
 */
export const makeLayer = (
  observed: Observed,
  {
    self = alice,
    refused = {},
    unknown = [],
    sendPost = (input) => certifyNext(observed, input),
    emit = (item) =>
      Effect.sync(() => {
        observed.emitted.push(item);
      }),
    admission,
  }: LayerOptions = {},
): Effect.Effect<CollectiveOperations, never, Scope.Scope> =>
  Effect.flatMap(Effect.scope, (scope) => {
    const persistence = collectivePersistencePorts((input) => {
      const reason = refused[input.to];
      if (reason === undefined) {
        return sendPost(input);
      }
      if (reason === "slow") {
        return Effect.never;
      }
      if (reason === "late") {
        return Effect.sleep(Duration.sum(requestSendWait, latePostDelay)).pipe(
          Effect.zipRight(sendPost(input)),
        );
      }
      return Effect.fail(new SendError({ reason }));
    });
    const checked = recordingAdmission(persistence.store, admission);
    return makeCollectiveOperations({
      ...persistence,
      ...(checked === undefined ? {} : { admission: checked }),
      self: Schema.decodeUnknownSync(AgentAddress)(self),
      lookupMember: (member) =>
        unknown.includes(member)
          ? Effect.fail(new SendError({ reason: "unknown-agent" }))
          : Effect.succeed(testAgentView(member)),
      emit,
      scope,
    });
  }).pipe(Effect.orDie);

/**
 * A post in the direct conversation with `sender`.
 * @param sender The agent that authored the post.
 * @param content The post's parts.
 * @returns The decoded inbound message.
 */
export const directPost = (sender: string, content: unknown) =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    postId: postId(9),
    address: sender,
    sender: testAgentView(sender),
    content,
  });

/**
 * A gather request post naming Bob's `requestId` and asking `questionText`
 * with `slotSchema` under `requestNonce`.
 * @param sender The agent that authored the request.
 * @param deadlineAt The absolute deadline it states, in epoch milliseconds.
 * @returns The decoded inbound message.
 */
export const requestPost = (sender: string, deadlineAt: number) =>
  directPost(sender, [
    { type: "text", text: questionText },
    {
      type: "data",
      value: {
        [collectiveKey]: {
          kind: "operation",
          op: "gather",
          id: requestId,
          nonce: requestNonce,
          deadlineAt,
          requestedSchema: slotSchema,
        },
      },
    },
  ]);

/**
 * A response post answering the operation `id`.
 * @param sender The member that answers.
 * @param id The operation the response names.
 * @param response The action and any content.
 * @returns The decoded inbound message.
 */
export const answerPost = (sender: string, id: string, response: object) =>
  directPost(sender, [
    {
      type: "data",
      value: { [collectiveKey]: { kind: "response", id, ...response } },
    },
  ]);

/**
 * Classify one post as certified under the shared record hash.
 * @param layer The layer that classifies it.
 * @param message The post, as the store delivered it.
 * @returns The item the layer delivers, or none when it consumes the post.
 */
export const classifyPost = (
  layer: CollectiveOperations,
  message: InboundMessage,
) => layer.classify({ message, recordHash });

/**
 * Send an unvalidated input through the layer, decoding it first.
 * @param layer The layer that sends.
 * @param input The send input before decoding.
 * @returns The send's outcome.
 */
export const send = (layer: CollectiveOperations, input: unknown) =>
  layer.send(Schema.decodeUnknownSync(SendInput)(input));

/**
 * A gather to `gatherTo` asking `questionText`.
 * @param deadline The relative deadline in seconds.
 * @param requestedSchema The schema answers must satisfy.
 * @returns The send input.
 */
export const gatherInput = (
  deadline = 60,
  requestedSchema: object = slotSchema,
) => ({
  to: gatherTo,
  text: questionText,
  collective: { op: "gather", deadline, requestedSchema },
});

/**
 * The refusal a send ends in.
 * @param effect The send, expected to fail.
 * @returns A collective failure's own value, or the send error itself.
 */
export const collectiveFailureOf = <A>(
  effect: Effect.Effect<A, SendError | CollectiveError | FirewallSendError>,
) =>
  Effect.flip(effect).pipe(
    Effect.map((error) =>
      error instanceof CollectiveError ? error.failure : error,
    ),
  );

/**
 * The operation id a completed send names; dies when it names none.
 * @param outcome What the send returned.
 * @param outcome.operationId The collective id, absent for a multicast.
 * @returns The id, for a test that goes on to answer or complete the operation.
 */
export const operationIdOf = (outcome: {
  readonly operationId?: CollectiveId;
}) =>
  Effect.fromNullable(outcome.operationId).pipe(
    Effect.orElse(() => Effect.dieMessage("the send named no operation")),
  );

/**
 * Start the gather `gatherInput` describes; dies when the send names no id.
 * @param layer The requester's layer.
 * @returns The gather's id.
 */
export const startGather = (layer: CollectiveOperations) =>
  send(layer, gatherInput()).pipe(Effect.flatMap(operationIdOf));

/**
 * The request the first recorded post carries; dies when that post carries
 * no gather or all_gather request.
 * @param observed What the layer's ports recorded.
 * @returns The request's collective value, with its id and nonce.
 */
export const firstRequestOf = (observed: Observed) =>
  Effect.fromNullable(observed.sent[0]).pipe(
    Effect.flatMap((post) => readCollectiveValue(post.content)),
    Effect.flatten,
    Effect.flatMap((value) =>
      Effect.fromNullable("nonce" in value ? value : undefined),
    ),
    Effect.orElse(() => Effect.dieMessage("the first post carries no request")),
  );

function recordingAdmission(
  store: ReturnType<typeof collectivePersistencePorts>["store"],
  admission?: CollectiveAdmission,
): CollectiveAdmission | undefined {
  return admission === undefined
    ? undefined
    : {
        bindPost: (input, hold) =>
          admission
            .bindPost(input, hold)
            .pipe(
              Effect.tap(() =>
                input.collective?.operation === undefined
                  ? Effect.void
                  : store
                      .putCollectiveOperation(input.collective.operation)
                      .pipe(Effect.orDie),
              ),
            ),
        admitGather: (candidate) =>
          admission
            .admitGather(candidate)
            .pipe(
              Effect.tap(() =>
                candidate.operation === undefined
                  ? Effect.void
                  : store
                      .putCollectiveOperation(candidate.operation)
                      .pipe(Effect.orDie),
              ),
            ),
      };
}
