/** @file Immutable policy metadata and retained check decoding. */

import { Effect, Schema, Struct } from "effect";
import {
  decodeRuntimeValue,
  type FirewallAuditEntry,
} from "../../communication/store/index.js";
import { exactStruct } from "../../encoding/exact.js";
import {
  decodeFrozen,
  firewallCheckSchema,
  FirewallSettings,
  Message,
  MessageContext,
  PrivateCheckTrace,
  RuleDescription,
} from "../evaluator/index.js";

// safer-arch-ignore file-implicit-boundary-module: Checking and audit projection share exact retained value schemas; only admission/index.ts exposes these private implementations to service composition.

/** Operational evidence limits are part of the installed policy identity. */
const firewallConfiguration = Schema.Struct({
  mode: Schema.Literal("guidance", "enforcement"),
  facts: MessageContext.fields.facts,
  codeDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  maximumHistoryRecords: Schema.Int.pipe(Schema.between(1, 1024)),
  maximumConcurrentChecks: Schema.Int.pipe(Schema.between(1, 32)),
});

/** Registration provenance is retained without giving it execution authority. */
const firewallRegistration = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  revision: Schema.NonEmptyTrimmedString,
  rules: Schema.Array(RuleDescription),
  provenance: PrivateCheckTrace,
});

/** The exact installation used by an attempt survives later process configuration. */
const firewallInstallation = Schema.Struct({
  configuration: firewallConfiguration,
  settings: FirewallSettings,
  incoming: Schema.Array(firewallRegistration),
  outgoing: Schema.Array(firewallRegistration),
});

/** A missing projected message records an unsupported candidate without inventing attribution. */
const firewallAuditInput = exactStruct({
  configurationDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  installation: firewallInstallation,
  context: MessageContext,
  message: Schema.NullOr(Message),
  terminal: Schema.Boolean,
});

/** Stored judgments exclude decision-provider traces. */
const firewallAuditResult = exactStruct({
  ...firewallCheckSchema.fields,
  checks: Schema.Array(
    Schema.Struct(
      Struct.omit(firewallCheckSchema.fields.checks.value.fields, "trace"),
    ),
  ),
});

/** Evidence limits and fixed facts captured before checking starts. */
export type FirewallConfiguration = typeof firewallConfiguration.Type;
/** Registration metadata remains tied to the policy edition that made a check. */
export type FirewallInstallation = typeof firewallInstallation.Type;

/** Configuration is copied and deeply frozen before it influences assessment. */
export const decodeFirewallConfiguration = (value: unknown) =>
  decodeFrozen(firewallConfiguration, value);
/** Trusted middleware metadata is copied without retaining caller-owned values. */
export const decodeFirewallRegistration = (value: unknown) =>
  decodeFrozen(firewallRegistration, value);
/** Installation bytes share one schema between checking and retained reads. */
export const decodeFirewallInstallation = (value: unknown) =>
  decodeFrozen(firewallInstallation, value);

/** Opaque retained bytes are interpreted only by their Client delivery owner. */
export const decodeFirewallAuditEntry = Effect.fn("decodeFirewallAuditEntry")(
  function* (entry: FirewallAuditEntry) {
    const input = yield* decodeRuntimeValue(
      firewallAuditInput,
      entry.canonicalInput,
    );
    const result =
      entry.canonicalResult === undefined
        ? null
        : yield* decodeRuntimeValue(firewallAuditResult, entry.canonicalResult);
    return {
      checkId: entry.checkId,
      direction: entry.direction,
      revision: entry.revision,
      disposition: entry.disposition,
      candidate: entry.canonicalCandidate,
      input,
      result,
    };
  },
);
