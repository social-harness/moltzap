/** @file Recording ports, message builders and send helpers shared by the collective operation tests. */

import { Duration, Effect, Schema, type Scope } from "effect";
import { createHash } from "node:crypto";
import type { CollectivePorts } from "../communication/collectives/ports.js";
import type { InboundItem } from "../host-protocol/items.js";
import {
  CollectiveEmitError,
  CollectiveError,
  type CollectiveId,
  SendInput,
} from "../communication/collectives/contracts.js";
import { readCollectiveValue } from "../communication/collectives/wire/index.js";
import { SendError } from "../communication/conversations/errors.js";
import {
  type EngineSendInput,
  RecipientResolutionError,
} from "../communication/conversations/index.js";
import { Message } from "../communication/message.js";
import { MsgId, RecordHash } from "../communication/records/index.js";
import { AgentAddress } from "../communication/records/values.js";
import { digest, testAgentView } from "./agent-card-fixtures.js";
import { collectiveOperationId } from "./collective-id-fixtures.js";
import { collectivePersistencePorts } from "./collective-message-fixtures.js";
import {
  type TestCollectiveOperations as CollectiveOperations,
  makeCollectiveOperations,
} from "./collective-send.js";

/** The agent a layer `makeLayer` builds runs as unless told otherwise. */
export const alice = Schema.decodeUnknownSync(AgentAddress)("agent:alice");

const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");

/** The data-part key a message carries its collective value under. */
export const collectiveKey = "org.social-harness/collective";

/** A form-mode schema asking for one required `slot`, `mon` or `tue`. */
export const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
};

/** Bob's gather request identity. */
export const requestId = collectiveOperationId(testAgentView(bob).agentId);

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

/** What a layer's ports saw: the messages it certified and the items it emitted, in order. */
export interface Observed {
  readonly sent: EngineSendInput[];
  readonly emitted: InboundItem[];
}

/**
 * A MsgId whose 32 bytes are all `byte`.
 * @param byte The repeated byte.
 * @returns The decoded MsgId.
 */
export const msgId = (byte: number) =>
  Schema.decodeUnknownSync(MsgId)(digest("msg_", byte));

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
 * Record a message and certify it as the engine does, under its own MsgId and
 * record hash: the nth message recorded gets byte `100 + n` for both, so neither
 * collides with the bytes below 100 a test gives the messages it classifies.
 * @param observed Where the message is recorded.
 * @param input The message being certified.
 * @returns The certified message's MsgId and record hash.
 */
export const certifyNext = (observed: Observed, input: EngineSendInput) =>
  Effect.sync(() => {
    observed.sent.push({ to: input.to, content: input.content });
    const byte = 100 + observed.sent.length;
    return { msgId: msgId(byte), recordHash: recordHashOf(byte) };
  });

/**
 * The send's wait for its request messages, mirroring the private
 * `request-sends.ts → REQUEST_SEND_WAIT`. Tests advance the test clock by it to
 * end that wait, so a change to the production bound is made here too.
 */
export const requestSendWait = Duration.seconds(20);

/** How long after the send's wait ends a `late` message certifies. */
export const lateMessageDelay = Duration.seconds(5);

/** What a test layer varies from ports that resolve, certify and keep everything. */
interface LayerOptions {
  /** The agent the layer runs as, `alice` by default. */
  readonly self?: string;
  /**
   * Addresses whose message is not passed to `sendMessage` at once: refused with the
   * reason given, held forever for `slow`, or passed on `lateMessageDelay` after
   * the send's `requestSendWait` ends for `late`.
   */
  readonly refused?: Readonly<
    Record<string, SendError["reason"] | "slow" | "late">
  >;
  /** Members whose lookup fails as an unknown agent. */
  readonly unknown?: readonly string[];
  /** Certifies each message `refused` lets through; `certifyNext` by default. */
  readonly sendMessage?: CollectivePorts["sendMessage"];
  /** Keeps each item the layer emits; by default it records the item. */
  readonly emit?: CollectivePorts["emit"];
}

/**
 * A collective layer over recording ports in the caller's scope. Its send
 * waits `requestSendWait` for request messages, so a test that needs that wait
 * to end advances the test clock by it.
 * @param observed Where the default ports record certified messages and emitted items.
 * @param options The agent the layer runs as, and the ports that differ from the recording defaults.
 * @param options.self The agent the layer runs as, `alice` by default.
 * @param options.refused Addresses whose message does not certify at once, and how it fares.
 * @param options.unknown Members whose lookup fails as an unknown agent.
 * @param options.sendMessage Certifies each message `refused` lets through.
 * @param options.emit Keeps each item the layer emits.
 * @returns The layer, scoped to the caller.
 */
export const makeLayer = (
  observed: Observed,
  {
    self = alice,
    refused = {},
    unknown = [],
    sendMessage = (input) => certifyNext(observed, input),
    emit = (item) =>
      Effect.sync(() => {
        observed.emitted.push(item);
      }),
  }: LayerOptions = {},
): Effect.Effect<CollectiveOperations, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const persistence = yield* collectivePersistencePorts((input) => {
      const reason = refused[input.to];
      if (reason === undefined) {
        return sendMessage(input);
      }
      if (reason === "slow") {
        return Effect.never;
      }
      if (reason === "late") {
        return Effect.sleep(
          Duration.sum(requestSendWait, lateMessageDelay),
        ).pipe(Effect.zipRight(sendMessage(input)));
      }
      return Effect.fail(new SendError({ reason }));
    }, self);
    const operations = yield* persistence.run(
      makeCollectiveOperations({
        ...persistence,
        self: testAgentView(self),
        prepareMessage: prepareKnownMembers(
          persistence.prepareMessage,
          unknown,
        ),
        emit,
        scope,
      }),
    );
    return {
      ...operations,
      classify: (message: Parameters<CollectiveOperations["classify"]>[0]) =>
        persistence
          .certifyInput(message)
          .pipe(Effect.zipRight(operations.classify(message))),
    };
  }).pipe(Effect.orDie, Effect.withSpan("makeLayer"));

/**
 * A message in the direct conversation with `sender`.
 * @param sender The agent that authored the message.
 * @param content The message's parts.
 * @returns The decoded inbound message.
 */
export const directMessage = (sender: string, content: unknown) =>
  Schema.decodeUnknownSync(Message)({
    msgId: msgId(9),
    content,
    author: testAgentView(sender),
    recipients: [testAgentView("agent:alice")],
  });

/**
 * A gather request message naming Bob's `requestId` and asking `questionText`
 * with `slotSchema`.
 * @param sender The agent that authored the request.
 * @param deadlineAt The absolute deadline it states, in epoch milliseconds.
 * @returns The decoded inbound message.
 */
export const requestMessage = (sender: string, deadlineAt: number) =>
  directMessage(sender, [
    { type: "text", text: questionText },
    {
      type: "data",
      value: {
        [collectiveKey]: {
          kind: "operation",
          op: "gather",
          operationId: requestId,
          deadlineAt,
          requestedSchema: slotSchema,
        },
      },
    },
  ]);

/**
 * A response message answering the operation `operationId`.
 * @param sender The member that answers.
 * @param operationId The operation the response names.
 * @param response The action and any content.
 * @returns The decoded inbound message.
 */
export const answerMessage = (
  sender: string,
  operationId: string,
  response: object,
) =>
  directMessage(sender, [
    {
      type: "data",
      value: {
        [collectiveKey]: { kind: "response", operationId, ...response },
      },
    },
  ]);

/**
 * Classify one message as certified under the shared record hash.
 * @param layer The layer that classifies it.
 * @param message The message, as the store delivered it.
 * @returns The item the layer delivers, or none when it consumes the message.
 */
export const classifyMessage = (
  layer: CollectiveOperations,
  message: Message,
) =>
  layer.classify({
    message,
    recordHash: Schema.decodeUnknownSync(RecordHash)(
      `rch_${createHash("sha256").update(JSON.stringify(message)).digest("base64url")}`,
    ),
  });

/**
 * Send an unvalidated input through the layer, decoding it first.
 * @param layer The layer that sends.
 * @param input The send input before decoding.
 * @returns The send's outcome.
 */
export const send = (layer: CollectiveOperations, input: unknown) =>
  layer
    .prepare(Schema.decodeUnknownSync(SendInput)(input))
    .pipe(Effect.flatMap((prepared) => layer.accept(prepared)));

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
  effect: Effect.Effect<A, SendError | CollectiveError>,
) =>
  Effect.flip(effect).pipe(
    Effect.map((error) =>
      error instanceof CollectiveError ? error.failure : error,
    ),
  );

/**
 * The operationId returned by a completed collective send. Dies if absent.
 * @param outcome What the send returned.
 * @param outcome.operationId The collective operationId, absent for a multicast.
 * @returns The operationId, for a test that goes on to answer or complete the operation.
 */
export const operationIdOf = (outcome: {
  readonly operationId?: CollectiveId;
}) =>
  Effect.fromNullable(outcome.operationId).pipe(
    Effect.orElse(() => Effect.dieMessage("the send named no operation")),
  );

/**
 * Start the gather `gatherInput` describes; dies when the send names no operationId.
 * @param layer The requester's layer.
 * @returns The gather's operationId.
 */
export const startGather = (layer: CollectiveOperations) =>
  send(layer, gatherInput()).pipe(Effect.flatMap(operationIdOf));

/**
 * The request the first recorded message carries; dies when that message carries
 * no gather or all_gather request.
 * @param observed What the layer's ports recorded.
 * @returns The request's collective value, with its operationId.
 */
export const firstRequestOf = (observed: Observed) =>
  Effect.fromNullable(observed.sent[0]).pipe(
    Effect.flatMap((message) => readCollectiveValue(message.content)),
    Effect.flatten,
    Effect.flatMap((value) =>
      Effect.fromNullable(value.kind === "operation" ? value : undefined),
    ),
    Effect.orElse(() =>
      Effect.dieMessage("the first message carries no request"),
    ),
  );

function prepareKnownMembers(
  prepare: CollectivePorts["prepareMessage"],
  unknown: readonly string[],
): CollectivePorts["prepareMessage"] {
  return (input) => {
    const missing = unknown
      .filter(
        (member) =>
          input.to === member ||
          (input.to.startsWith("group:") &&
            input.to.slice(6).split(",").includes(member.slice(6))),
      )
      .map((member) => ({
        member: Schema.decodeUnknownSync(AgentAddress)(member),
        cause: new SendError({ reason: "unknown-agent" }),
      }));
    const [first, ...rest] = missing;
    return first === undefined
      ? prepare(input)
      : Effect.fail(
          new RecipientResolutionError({ failures: [first, ...rest] }),
        );
  };
}
