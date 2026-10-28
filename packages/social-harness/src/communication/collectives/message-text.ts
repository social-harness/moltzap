/**
 * @file Reads the operation a message's text states.
 *
 * In native hosts, a model reaches every operation through the ordinary
 * message tool, as message text. The OpenClaw and NanoClaw adapters use
 * {@link parseMessageText}, so both hosts accept the same text:
 *
 * ```
 * plain text                                                   multicast
 * {"gather": "Which day?", "deadline": 600, "requestedSchema": {...}}
 * {"all_gather": "Which day?", "deadline": 600, "requestedSchema": {...}}
 * {"action": "accept", "id": "col_...", "content": {...}}       answer
 * {"action": "decline", "id": "col_..."}                        answer
 * ```
 *
 * Only a whole text that is a JSON object with a `gather`, `all_gather` or
 * `action` key states an operation; any other text, JSON-looking prose
 * included, is a multicast of that text. A text that states an operation but
 * fails validation is refused, never sent as text, because the model meant
 * the operation and the error names the field to fix.
 */

import {
  Config,
  type ConfigError,
  Data,
  Effect,
  Either,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { MessageAddressInput } from "../records/values.js";
import { exactStruct } from "../../encoding/exact.js";
import {
  AcceptResponse,
  type CollectiveResponse,
  DeadlineSeconds,
  DeclineResponse,
  describeIssues,
  RequestedSchema,
  SendInput,
} from "./forms.js";

/* eslint-disable @typescript-eslint/naming-convention -- Effect Schemas are named for the text shapes they decode. */

/** The operations that ask a question, in the order their keys are read. */
const COLLECTING_OPERATIONS = ["gather", "all_gather"] as const;

type CollectingOperation = (typeof COLLECTING_OPERATIONS)[number];

/** Which operation a refused text stated. */
type StatedOperation = "message" | CollectingOperation | "answer";

/**
 * A message text states an operation it does not validly carry, or is plain
 * text that is not well-formed Unicode. The message names each failing field
 * so a host can hand it to its model as the tool error.
 */
export class MessageTextError extends Data.TaggedError("MessageTextError")<{
  readonly operation: StatedOperation;
  readonly detail: string;
}> {
  override get message(): string {
    const action = this.operation === "answer" ? "reply" : "send";
    return `${action} failed: invalid ${this.operation}: ${this.detail}`;
  }
}

/** A native channel send names a capability hidden for an evaluation. */
export class ChannelFeatureUnavailableError extends Data.TaggedError(
  "ChannelFeatureUnavailableError",
)<{ readonly feature: "groups" | "collectives" }> {
  override get message(): string {
    const refusal =
      this.feature === "groups"
        ? "group addresses are not available; message each agent at its agent: address"
        : "gather, all_gather and answers are not available; send plain text instead";
    return `send failed: ${refusal}. Docs: https://docs.moltzap.xyz/integrations/experiment-switches#experiment-switches`;
  }
}

/**
 * A gather or all_gather, its question under the operation's own key, read
 * as `question` so both share one decode.
 */
const collectingText = (op: CollectingOperation) =>
  exactStruct({
    question: Schema.propertySignature(Schema.String).pipe(Schema.fromKey(op)),
    deadline: DeadlineSeconds,
    requestedSchema: RequestedSchema,
  });

/** The `action` key alone, so an unknown action is named as that field. */
const AnswerAction = Schema.Struct({
  action: Schema.Literal("accept", "decline"),
});

const decodeJsonText = Schema.decodeUnknownOption(
  Schema.parseJson(Schema.Unknown),
);

/** The JSON object a whole text is, if it is one. */
const jsonObject = (text: string) =>
  decodeJsonText(text).pipe(Option.filter(Predicate.isRecord));

/**
 * Read one message text as the send it states.
 * @param to The address the host's tool call names: the recipients of a
 *   multicast, gather or all_gather, or for an answer the conversation whose
 *   open request it answers.
 * @param text The whole text of the message.
 * @returns The send input, or an error naming each field a stated operation
 *   gets wrong.
 */
export const parseMessageText = (
  to: MessageAddressInput,
  text: string,
): Either.Either<SendInput, MessageTextError> =>
  Option.match(jsonObject(text), {
    onNone: () => sendInput("message", { to, text }),
    onSome: (value) =>
      statedOperation(to, value) ?? sendInput("message", { to, text }),
  });

/**
 * Read native channel text with the evaluation switches applied, using
 * Effect's boolean config with false as the default. Only a switch covering
 * this send is read; invalid values fail with its name.
 * Group refusal precedes collective refusal, including malformed operations.
 * These switches constrain outbound capabilities only, not incoming messages.
 */
export function readChannelMessage(
  to: MessageAddressInput,
  text: string,
): Effect.Effect<
  SendInput,
  MessageTextError | ChannelFeatureUnavailableError | ConfigError.ConfigError
> {
  const parsed = parseMessageText(to, text);
  const operation = Either.match(parsed, {
    onLeft: (error) => error.operation !== "message",
    onRight: (input) =>
      "collectiveResponse" in input || input.collective !== undefined,
  });
  return Effect.gen(function* () {
    if (to.startsWith("group:")) {
      const hidden = yield* Config.boolean(
        "SHARNESS_EXPERIMENT_HIDE_GROUPS",
      ).pipe(Config.withDefault(false));
      if (hidden) {
        return yield* new ChannelFeatureUnavailableError({ feature: "groups" });
      }
    }
    if (operation) {
      const hidden = yield* Config.boolean(
        "SHARNESS_EXPERIMENT_HIDE_COLLECTIVES",
      ).pipe(Config.withDefault(false));
      if (hidden) {
        return yield* new ChannelFeatureUnavailableError({
          feature: "collectives",
        });
      }
    }
    return yield* parsed;
  }).pipe(Effect.withSpan("readChannelMessage"));
}

/**
 * The operation a JSON object states by its key, or undefined when it has
 * none of `gather`, `all_gather` and `action` and so is plain text.
 */
function statedOperation(
  to: MessageAddressInput,
  value: Readonly<Record<string, unknown>>,
): Either.Either<SendInput, MessageTextError> | undefined {
  const op = COLLECTING_OPERATIONS.find((key) => Object.hasOwn(value, key));
  if (op !== undefined) {
    return decodeText(op, collectingText(op), value).pipe(
      Either.flatMap(({ question, ...collective }) =>
        sendInput(op, {
          to,
          text: question,
          collective: { ...collective, op },
        }),
      ),
    );
  }
  return Object.hasOwn(value, "action") ? answer(to, value) : undefined;
}

/** An answer: `action` decides which shape the rest must have. */
function answer(
  to: MessageAddressInput,
  value: Readonly<Record<string, unknown>>,
): Either.Either<SendInput, MessageTextError> {
  return decodeText("answer", AnswerAction, value).pipe(
    Either.flatMap(
      ({ action }): Either.Either<CollectiveResponse, MessageTextError> =>
        action === "accept"
          ? decodeText("answer", AcceptResponse, value)
          : decodeText("answer", DeclineResponse, value),
    ),
    Either.flatMap((collectiveResponse) =>
      sendInput("answer", { to, collectiveResponse }),
    ),
  );
}

function sendInput(
  operation: StatedOperation,
  value: unknown,
): Either.Either<SendInput, MessageTextError> {
  return decodeText(operation, SendInput, value);
}

function decodeText<A, I>(
  operation: StatedOperation,
  schema: Schema.Schema<A, I>,
  value: unknown,
): Either.Either<A, MessageTextError> {
  return Schema.decodeUnknownEither(schema, { errors: "all" })(value).pipe(
    Either.mapLeft(
      (error) =>
        new MessageTextError({ operation, detail: describeIssues(error) }),
    ),
  );
}

/* eslint-enable @typescript-eslint/naming-convention -- Restore the package naming rules after the text Schemas. */
