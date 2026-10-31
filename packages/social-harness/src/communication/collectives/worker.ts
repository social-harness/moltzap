/** @file Submits saved messages independently of host calls. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Cause, Clock, Deferred, Effect, Schema } from "effect";

import type { SendOutcome } from "../index.js";
import type { Environment } from "./environment.js";

import { Message, replyAddress } from "../message.js";
import { agentAddressOf } from "../records/values.js";
import { transaction } from "../store/database/index.js";
import * as Store from "../store/index.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  EndpointStoreError,
} from "../store/index.js";
import { CollectiveId } from "./contracts.js";
import { CollectivesError } from "./errors.js";
import { frozenResult } from "./model.js";
import { finishLocal, finishRemote, publishResult } from "./results.js";

interface Submission {
  readonly operationId: CollectiveId;
  readonly role: "request" | "response" | "close";
  readonly message: Message;
}

/** Custody submission starts outside incoming handoff transactions. */
export function runWorker(environment: Environment) {
  return workerPass(environment).pipe(
    Effect.zipRight(Effect.sleep("100 millis")),
    Effect.forever,
  );
}

/** Every accepted task belongs to the service scope and reports storage failure. */
export function start(
  environment: Environment,
  work: Effect.Effect<
    void,
    CollectivesError | EndpointStoreError,
    SqlClient.SqlClient
  >,
) {
  return work.pipe(
    Effect.provideService(SqlClient.SqlClient, environment.sql),
    Effect.catchTag("EndpointStoreError", () =>
      Deferred.fail(
        environment.failed,
        new CollectivesError({ reason: "persistence-failed" }),
      ),
    ),
    Effect.catchTag("CollectivesError", (error) =>
      Deferred.fail(environment.failed, error),
    ),
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.interrupt
        : Deferred.failCause(environment.failed, cause),
    ),
    Effect.asVoid,
    Effect.interruptible,
    Effect.forkIn(environment.scope),
    Effect.asVoid,
  );
}

function workerPass(environment: Environment) {
  return Effect.gen(function* () {
    for (const operation of yield* Store.readOpenCollectiveOperations()) {
      const operationId = yield* checkedOperationId(operation.operationId);
      if (operation.origin === "local") {
        yield* finishLocal(operationId);
      } else {
        yield* finishRemote(environment, operationId);
      }
    }
    for (const saved of yield* Store.readPendingCollectiveMessages()) {
      const operationId = yield* checkedOperationId(saved.operationId);
      const message = yield* decodeRuntimeValue(
        Message,
        saved.canonicalMessage,
      );
      const key = `${message.author.agentId}:${message.msgId}`;
      if (environment.activeMessages.has(key)) {
        continue;
      }
      environment.activeMessages.add(key);
      yield* start(
        environment,
        submitSaved(environment, {
          operationId,
          role: saved.role,
          message,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => environment.activeMessages.delete(key)),
          ),
        ),
      );
    }
  });
}

function checkedOperationId(operationId: string) {
  return Schema.decodeUnknown(CollectiveId)(operationId).pipe(
    Effect.catchTag(
      "ParseError",
      () => new EndpointStoreError({ reason: "corrupt" }),
    ),
  );
}

function submitSaved(environment: Environment, submission: Submission) {
  return submit(environment, submission.message).pipe(
    Effect.matchEffect({
      onFailure: (error) => refuseSubmission(submission, error),
      onSuccess: (sent) => completeSubmission(environment, submission, sent),
    }),
  );
}

function refuseSubmission(submission: Submission, error: CollectivesError) {
  if (submission.role === "response") {
    return Effect.void;
  }
  return transaction(
    Effect.gen(function* () {
      if (submission.role === "close") {
        yield* closeFailure(submission.operationId, submission.message, error);
      }
      yield* Store.completeCollectiveMessage({
        authorAgentId: submission.message.author.agentId,
        msgId: submission.message.msgId,
      });
    }),
  );
}

function completeSubmission(
  environment: Environment,
  submission: Submission,
  sent: SendOutcome,
) {
  return Effect.gen(function* () {
    if (submission.role !== "request" && sent.kind === "pending") {
      yield* environment.communication.waitForMessage(sent.message).pipe(
        Effect.catchTag(
          "CommunicationError",
          (error) =>
            new CollectivesError({
              reason: "message-failed",
              detail: error.reason,
            }),
        ),
      );
    }
    yield* transaction(completeCertifiedSubmission(submission));
    if (submission.role === "response") {
      yield* finishRemote(environment, submission.operationId);
    }
  });
}

function completeCertifiedSubmission({
  operationId,
  role,
  message,
}: Submission) {
  return Effect.gen(function* () {
    if (role === "response") {
      yield* Store.recordCollectiveAnswer(
        {
          operationId,
          member: agentAddressOf(message.author),
          canonicalMessage: yield* encodeRuntimeValue(message),
        },
        yield* Clock.currentTimeMillis,
      );
    }
    if (role === "close") {
      const operation = yield* Store.readCollectiveOperation(operationId);
      if (
        operation === undefined ||
        operation.canonicalSelection === undefined
      ) {
        return yield* new EndpointStoreError({ reason: "corrupt" });
      }
      yield* publishResult(
        operationId,
        yield* decodeRuntimeValue(frozenResult, operation.canonicalSelection),
      );
    }
    yield* Store.completeCollectiveMessage({
      authorAgentId: message.author.agentId,
      msgId: message.msgId,
    });
  });
}

function closeFailure(
  operationId: CollectiveId,
  message: Message,
  error: CollectivesError,
) {
  return publishResult(operationId, {
    item: {
      kind: "operationFailed",
      operationId,
      to: replyAddress(message),
      error: `The collective result could not be shared: ${error.detail ?? error.reason}`,
    },
    sources: { answers: [] },
  });
}

function submit(environment: Environment, message: Message) {
  return environment.communication.send(message).pipe(
    Effect.catchTag(
      "CommunicationError",
      (error) =>
        new CollectivesError({
          reason: "message-failed",
          detail: error.reason,
        }),
    ),
  );
}
