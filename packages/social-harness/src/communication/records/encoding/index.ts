/** @file Canonical JCS bytes and the hashes, identifiers and signatures computed over them. */

/* eslint-disable jsdoc/require-jsdoc -- Re-exported private symbols retain their owning-module documentation. */

export {
  type DecodedOuterBody,
  decodeOuterBody,
  deriveConversationId,
  deriveEvidenceEnvelopeId,
  hashAction,
  hashAnchor,
  hashMembershipDescriptor,
  hashMessageIntent,
  hashRecord,
  mintMsgId,
  type OuterBodyReader,
  type OuterMembership,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
} from "./codec.js";

/* eslint-enable jsdoc/require-jsdoc -- Restore package documentation rules. */
