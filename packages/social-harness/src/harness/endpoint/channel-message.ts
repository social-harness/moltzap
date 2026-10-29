/**
 * @file Reads a native channel's outbound message text as a send, with the
 * evaluation experiment switches applied.
 *
 * The OpenClaw and NanoClaw adapters read every send here, so both accept the
 * same text and return the same refusals. Each switch is an environment
 * variable read through Effect's boolean config, false when unset, and only
 * for a send it covers, so an unreadable value fails only those sends. The
 * switches limit what an agent sends, not what it receives.
 */

import { Config, Data, Effect, Either } from "effect";
import type { SendInput } from "../../communication/collectives/forms.js";
import type { MessageAddressInput } from "../../communication/records/values.js";
import {
  type MessageTextError,
  parseMessageText,
} from "../../communication/collectives/message-text.js";

const DOCS =
  "Docs: https://docs.moltzap.xyz/reference/experiment-switches#experiment-switches";

/** A native channel send names a capability hidden for an evaluation. */
export class ChannelFeatureUnavailableError extends Data.TaggedError(
  "ChannelFeatureUnavailableError",
)<{ readonly feature: "groups" | "collectives" }> {
  override get message(): string {
    const refusal =
      this.feature === "groups"
        ? "group addresses are not available; message each agent at its agent: address"
        : "gather, all_gather and answers are not available; send plain text instead";
    return `send failed: ${refusal}. ${DOCS}`;
  }
}

/** The experiment switch covering a send is set to a value that is not a boolean. */
export class ExperimentSwitchInvalidError extends Data.TaggedError(
  "ExperimentSwitchInvalidError",
)<{
  readonly variable:
    | "SHARNESS_EXPERIMENT_HIDE_GROUPS"
    | "SHARNESS_EXPERIMENT_HIDE_COLLECTIVES";
}> {
  override get message(): string {
    return `send failed: ${this.variable} must be true, yes, on or 1 to enable the switch, or false, no, off or 0 to disable it. ${DOCS}`;
  }
}

/** The variable that hides each feature. */
const SWITCHES = {
  groups: "SHARNESS_EXPERIMENT_HIDE_GROUPS",
  collectives: "SHARNESS_EXPERIMENT_HIDE_COLLECTIVES",
} as const satisfies Record<
  ChannelFeatureUnavailableError["feature"],
  ExperimentSwitchInvalidError["variable"]
>;

/**
 * Read one native channel send's text as the send it states. A `group:`
 * address is refused while groups are hidden, and text that states a gather,
 * all_gather or answer, validly or not, while collectives are hidden; the group
 * refusal comes first.
 * @param to The address the host's send names.
 * @param text The whole text of the message.
 * @returns The send input, or the refusal, invalid switch or text error the
 *   channel hands to its model.
 */
export function readChannelMessage(
  to: MessageAddressInput,
  text: string,
): Effect.Effect<
  SendInput,
  | MessageTextError
  | ChannelFeatureUnavailableError
  | ExperimentSwitchInvalidError
> {
  const parsed = parseMessageText(to, text);
  const statesOperation = Either.match(parsed, {
    onLeft: (error) => error.operation !== "message",
    onRight: (input) =>
      "collectiveResponse" in input || input.collective !== undefined,
  });
  return refuseWhileHidden(to.startsWith("group:"), "groups").pipe(
    Effect.zipRight(refuseWhileHidden(statesOperation, "collectives")),
    Effect.zipRight(parsed),
    Effect.withSpan("readChannelMessage"),
  );
}

/** Fail while `feature`'s switch is on, reading it only when it covers the send. */
function refuseWhileHidden(
  covered: boolean,
  feature: ChannelFeatureUnavailableError["feature"],
): Effect.Effect<
  void,
  ChannelFeatureUnavailableError | ExperimentSwitchInvalidError
> {
  if (!covered) {
    return Effect.void;
  }
  const variable = SWITCHES[feature];
  return Config.boolean(variable).pipe(
    Config.withDefault(false),
    Effect.catchTag("ConfigError", () =>
      Effect.fail(new ExperimentSwitchInvalidError({ variable })),
    ),
    Effect.flatMap((hidden) =>
      hidden
        ? Effect.fail(new ChannelFeatureUnavailableError({ feature }))
        : Effect.void,
    ),
  );
}
