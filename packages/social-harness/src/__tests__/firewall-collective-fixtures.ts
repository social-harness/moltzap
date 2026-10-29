/** @file Shared values and helpers for the collective-operation firewall suites: alice's members, Bob's requests and the sends alice makes. */

import { Effect, Queue, Schema } from "effect";
import type { MiddlewareInput } from "../firewall/evaluator/contract/index.js";
import { SendInput } from "../communication/collectives/contracts.js";
import {
  decodeCollectiveValue,
  encodeCollectiveContent,
} from "../communication/collectives/wire/index.js";
import {
  AgentAddress,
  MessageAddressInput,
} from "../communication/records/values.js";
import { testAgentView } from "./agent-card-fixtures.js";
import { appendCertifiedMessage } from "./certified-history-fixtures.js";
import { collectiveOperationId } from "./collective-id-fixtures.js";
import {
  block,
  type Fixture,
  type incomingFixture,
  pass,
  policy,
  seedIncoming,
} from "./firewall-runtime-fixtures.js";

/** Bob's address, the remote member of alice's direct conversation. */
export const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
/** Carol's address, the third member alice can reach. */
export const carol = Schema.decodeUnknownSync(AgentAddress)("agent:carol");
/** The group of alice, Bob and Carol. */
export const group = Schema.decodeUnknownSync(MessageAddressInput)(
  "group:alice,bob,carol",
);
/** Text a `holdMarked` policy holds. */
export const marker = "[hold]";
/** The question the suites ask. */
export const question = "Which day works?";
/** How many captures a check makes before its third attempt holds without inference. */
export const STALE_CAPTURES = 2;
/** The form the suites' requests ask for. */
export const formSchema = {
  type: "object",
  properties: {
    slot: { type: "string", enum: ["mon", "tue"] },
    note: { type: "string" },
  },
  required: ["slot"],
} as const;

/** The incoming runtime a suite drives. */
export type IncomingRuntime = Effect.Effect.Success<
  ReturnType<typeof incomingFixture>
>;

/**
 * A policy that blocks any message whose text carries `marker`, recording
 * what it saw.
 * @param seen Receives each input the policy checks.
 * @returns The middleware.
 */
export function holdMarked(seen: MiddlewareInput[] = []) {
  return policy((input) =>
    Effect.sync(() => {
      seen.push(input);
      return input.event.message.text.includes(marker) ? block : pass;
    }),
  );
}

/**
 * Bob's gather request to alice, closing at `deadlineAt`.
 * @param deadlineAt The request's absolute deadline in epoch milliseconds.
 * @param text The question's text.
 * @returns The request message's content.
 */
export function gatherRequestContent(deadlineAt: number, text: string) {
  return collectiveContent(
    {
      kind: "operation",
      op: "gather",
      operationId: collectiveOperationId(testAgentView(bob).agentId),
      deadlineAt,
      requestedSchema: formSchema,
    },
    text,
  );
}

/**
 * Alice's store holds a direct conversation with Bob that alice opened, and
 * Bob's gather request after it, still pending delivery.
 * @param subject The fixture whose store is seeded.
 * @param deadlineAt The request's absolute deadline in epoch milliseconds.
 * @param text The question's text.
 * @returns The request's certified record.
 */
export function seedRequest(
  subject: Fixture,
  deadlineAt: number,
  text: string,
) {
  return Effect.gen(function* () {
    const firstMessage = yield* seedIncoming(subject, true);
    return yield* appendCertifiedMessage(
      subject,
      firstMessage,
      yield* gatherRequestContent(deadlineAt, text),
    );
  }).pipe(Effect.withSpan("seedRequest"));
}

/**
 * Content carrying one collective value, decoded as a peer would send it.
 * @param value The undecoded part value, as it travels.
 * @param text The message's text part, if any.
 * @returns The message's content.
 */
export function collectiveContent(value: object, text?: string) {
  return decodeCollectiveValue(value).pipe(
    Effect.flatMap((decoded) => encodeCollectiveContent(decoded, text)),
    Effect.orDie,
  );
}

/**
 * Run the admission worker once over what the store holds pending.
 * @param runtime The suite's delivery, store and worker.
 * @returns Completion once one admission commits.
 */
export function admitPending(runtime: IncomingRuntime) {
  return runtime.runPass.pipe(Effect.zipRight(Queue.take(runtime.completed)));
}

/**
 * The message intents a test's sends bound, which no certified record completes yet.
 * @param subject The fixture whose store is read.
 * @returns Every bound intent without a certified record.
 */
export function unfinishedIntents(subject: Fixture) {
  return subject.store
    .recover()
    .pipe(
      Effect.map(({ messageIntents }) =>
        messageIntents.filter(
          (intent) => intent.completedRecordHash === undefined,
        ),
      ),
    );
}

/**
 * Alice's answer to Bob's open request.
 * @param content The answer's fields.
 * @returns The send input.
 */
export function answerBob(content: object) {
  return sendInput({
    to: bob,
    collectiveResponse: { action: "accept", content },
  });
}

/**
 * Alice's gather or all_gather to the group, closing in 60 seconds.
 * @param text The question.
 * @param op The collecting operation.
 * @returns The send input.
 */
export function gatherSend(
  text: string,
  op: "gather" | "all_gather" = "gather",
) {
  return sendInput({
    to: group,
    text,
    collective: { op, deadline: 60, requestedSchema: formSchema },
  });
}

/**
 * One send of the delivery operations, decoded as a host's send input.
 * @param input The host's input.
 * @returns The validated send input.
 */
export function sendInput(input: unknown) {
  return Schema.decodeUnknownSync(SendInput)(input);
}
