/** @file Reset representation parameters, separate from version-window policy. */

import { WIRE_VERSION } from "../wire-version.js";

/**
 * A reset admits one representation profile. Retained versions that change a
 * type, hash domain or bound add an entry here before those representations
 * can coexist; injected adjacent-release tests intentionally share this profile.
 */
export const WIRE_PROFILES = {
  [WIRE_VERSION]: {
    signedMessageType: "application/vnd.sharness.signed-message+jws",
    commitmentHeader: "org.social-harness/commitment",
    messageIdHeader: "org.social-harness/message-id",
    senderHeader: "org.social-harness/sender",
    maximumBodyBytes: 262_144,
    maximumRecipients: 128,
  },
} as const;
