/** @file Shared native-channel text parsing and experiment refusal messages. */

import { Data, Effect } from "effect";
import type { SendInput } from "../../communication/collectives/forms.js";
import type { MessageAddressInput } from "../../communication/records/values.js";
import {
  type MessageTextError,
  parseMessageText,
} from "../../communication/collectives/message-text.js";

const DOCS =
  "Docs: https://docs.moltzap.xyz/integrations/experiment-switches#experiment-switches";

/** A send names a capability the daemon hides for an evaluation. */
export class ChannelFeatureUnavailableError extends Data.TaggedError(
  "ChannelFeatureUnavailableError",
)<{ readonly feature: "groups" | "collectives" }> {
  get detail(): string {
    const refusal =
      this.feature === "groups"
        ? "group addresses are not available; message each agent at its agent: address"
        : "gather, all_gather and answers are not available; send plain text instead";
    return `${refusal}. ${DOCS}`;
  }

  override get message(): string {
    return `send failed: ${this.detail}`;
  }
}

/** A daemon experiment switch is set to a value that is not a boolean. */
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

/**
 * Parse the whole native-channel message into one semantic send.
 * @param to The explicit address supplied by the host.
 * @param text The whole message text.
 * @returns The semantic send or its text validation error.
 */
export function readChannelMessage(
  to: MessageAddressInput,
  text: string,
): Effect.Effect<SendInput, MessageTextError> {
  return Effect.suspend(() => parseMessageText(to, text));
}
