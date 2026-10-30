/** @file Decodes host send arguments and defines operation results and failure reasons. */

import { Effect, type ParseResult, Schema } from "effect";
import { exactParseOptions } from "../encoding/exact.js";
import {
  harnessSendArgumentsSchema,
  type HarnessSendRequest,
} from "./operations.js";

const exactEmptyObject = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
}).annotations({ parseOptions: exactParseOptions });

/** The empty result of an adapter operation. */
export const harnessEmptyResultSchema = exactEmptyObject;

/**
 * Validate the model-visible arguments at the daemon boundary.
 * @param toolArguments Model-visible arguments.
 * @returns One validated send request.
 */
export function decodeHarnessSendCall(
  toolArguments: unknown,
): Effect.Effect<HarnessSendRequest, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessSendArgumentsSchema, {
    errors: "all",
  })(toolArguments).pipe(Effect.withSpan("decodeHarnessSendCall"));
}

/** Decoded empty adapter-operation result. */
export type HarnessEmptyResult = typeof harnessEmptyResultSchema.Type;

/** Admission refusal names the credential to replace without disclosing its value. */
export const registrationAdmissionRefusalMessage =
  "The Registry refused the admission credential; supply this network's admission credential and register again. Docs: https://docs.moltzap.xyz/guides/run-sharnessd#the-registry-refused-the-admission-credential";

/** Closed wire failure vocabularies prevent internal diagnostics from escaping. */
export const harnessFailureReasons = {
  RUNTIME_READ_REASONS: new Set([
    "not-registered",
    "invalid-continuation",
    "invalid-event",
    "unknown-event",
    "persistence-failed",
  ]),
  REGISTER_REASONS: new Set([
    "admission-refused",
    "dependency-unavailable",
    "persistence-failed",
    "incompatible-daemon",
  ]),
  STATUS_REASONS: new Set(["incompatible-daemon"]),
  SEARCH_AGENTS_REASONS: new Set([
    "not-registered",
    "dependency-unavailable",
    "incompatible-daemon",
  ]),
  SEARCH_CONVERSATIONS_REASONS: new Set([
    "not-registered",
    "invalid-address",
    "persistence-failed",
  ]),
  READ_CONVERSATION_REASONS: new Set([
    "not-registered",
    "invalid-address",
    "unknown-agent",
    "invalid-continuation",
    "history-gap",
    "persistence-failed",
  ]),
  ACKNOWLEDGE_DELIVERY_REASONS: new Set([
    "unknown-delivery",
    "delivery-conflict",
    "persistence-failed",
    "transport-failed",
  ]),
};
