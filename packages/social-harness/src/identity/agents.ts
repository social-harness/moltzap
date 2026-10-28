/** @file Canonical branded identity identifiers and their exact encodings. */

import { Schema } from "effect";
import { canonicalIdentifier } from "../encoding/identifier.js";

const IDENTIFIER_BYTE_LENGTH = 16;

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Named Effect Schemas share their domain names with the nominal types they decode.
 */

/** Canonical network identity minted by the Registry. */
export const AgentId = canonicalIdentifier(
  "AgentId",
  "agt_",
  IDENTIFIER_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link AgentId}. */
export type AgentId = typeof AgentId.Type;

/** Opaque identity of the principal represented by an agent. */
export const PrincipalId = canonicalIdentifier(
  "PrincipalId",
  "prn_",
  IDENTIFIER_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link PrincipalId}. */
export type PrincipalId = typeof PrincipalId.Type;

/** The rule every agent name meets, as validation errors state it. */
export const AGENT_NAME_RULE =
  "3 to 32 lowercase letters, digits or single hyphens, starting and ending with a letter or digit";

/** Immutable Registry-wide human-facing agent handle. */
export const AgentName = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(32),
  Schema.pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  Schema.brand("AgentName"),
  Schema.annotations({
    identifier: "AgentName",
    description: `an agent name: ${AGENT_NAME_RULE}`,
  }),
);
/** Validated nominal value decoded by {@link AgentName}. */
export type AgentName = typeof AgentName.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Restore the general naming rules after the public Schema/type pairs.
 */
