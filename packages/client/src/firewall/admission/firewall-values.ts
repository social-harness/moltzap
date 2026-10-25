/** @file Immutable policy metadata and versioned operator audit values. */

import { Effect, Schema } from "effect";
import { InboundItem } from "../../communication/collectives/inbound.js";
import { PostIntent } from "../../communication/records/index.js";
import { PostId } from "../../communication/records/values.js";
import {
  decodeRuntimeValue,
  EndpointStoreError,
  type FirewallAuditEntry,
} from "../../communication/store/index.js";
import { exactStruct } from "../../encoding/exact.js";
import { AgentId } from "../../identity/agents.js";
import {
  decodeFrozen,
  firewallActivationSchema,
  FirewallSettings,
  Message,
  MessageContext,
  MiddlewareObservation,
  NormExpectation,
  PrivateCheckTrace,
  RuleDescription,
  UncertainNormGuidance,
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

const digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const format = Schema.Literal("org.social-harness/firewall-audit/v4");
const snapshotId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));

/** The public author-scoped post identity joins an assessment to endpoint history. */
const firewallAuditPost = exactStruct({
  authorAgentId: AgentId,
  postId: PostId,
});

const middlewareFailure = Schema.Struct({
  _tag: Schema.Literal("MiddlewareError"),
  reason: Schema.Literal(
    "unavailable",
    "timeout",
    "invalid-result",
    "budget",
    "defect",
  ),
});

/** Retained results keep private traces and judgments distinct from store admission. */
const firewallAuditResult = exactStruct({
  judgment: Schema.Literal("allow", "block", "hold", "revise"),
  reason: Schema.Literal(
    "eligible",
    "prohibited",
    "unresolved-evidence",
    "check-unavailable",
    "norm-violation",
    "approval-required",
  ),
  feedback: Schema.Array(
    Schema.Struct({
      nextAction: Schema.Literal("revise", "wait", "stop", "seek-approval"),
      text: Schema.String,
    }),
  ),
  guidance: Schema.Array(
    Schema.Union(
      Schema.Struct({
        ...NormExpectation.fields,
        middlewareId: Schema.String,
        instruction: Schema.String,
      }),
      UncertainNormGuidance,
    ),
  ),
  checks: Schema.Array(
    Schema.Struct({
      ...MiddlewareObservation.fields,
      /** Wall-clock subtraction can be negative after a clock adjustment. */
      elapsedMilliseconds: Schema.Finite,
      failure: Schema.optional(middlewareFailure),
      trace: Schema.optional(PrivateCheckTrace),
    }),
  ),
});

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the decoded operator values. */

/**
 * One NDJSON record in an operator-only shutdown snapshot. A complete file has
 * one start, every retained check and activation, and one matching complete record.
 * Its digest covers the UTF-8 check and activation lines including trailing newlines.
 * Candidate bytes are opaque canonical Client data, encoded as base64. A null
 * result or checking/interrupted disposition never represents permission.
 * The nullable post reference identifies supported messages without decoding candidate bytes.
 */
export const FirewallAuditRecord = Schema.Union(
  exactStruct({
    kind: Schema.Literal("start"),
    format,
    snapshotId,
    startedAt: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("check"),
    checkId: Schema.NonEmptyString,
    direction: Schema.Literal("incoming", "outgoing"),
    revision: Schema.NonNegativeInt,
    disposition: Schema.Literal(
      "checking",
      "interrupted",
      "stale",
      "admitted",
      "withheld",
    ),
    post: Schema.NullOr(firewallAuditPost),
    candidate: Schema.Uint8ArrayFromBase64,
    input: firewallAuditInput,
    result: Schema.NullOr(firewallAuditResult),
  }),
  exactStruct({
    kind: Schema.Literal("activation"),
    ...firewallActivationSchema.fields,
  }),
  exactStruct({
    kind: Schema.Literal("complete"),
    format,
    snapshotId,
    checkCount: Schema.NonNegativeInt,
    activationCount: Schema.NonNegativeInt,
    sha256: digest,
  }),
).annotations({ identifier: "FirewallAuditRecord" });

/** Completion verifies the snapshot, not completion or delivery of each attempt. */
export type FirewallAuditRecord = typeof FirewallAuditRecord.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore package naming after the Schema/type pair. */

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
/** Installation bytes share one schema between checking and operator export. */
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
      kind: "check",
      checkId: entry.checkId,
      direction: entry.direction,
      revision: entry.revision,
      disposition: entry.disposition,
      post: yield* auditPost(entry, input.message),
      candidate: entry.canonicalCandidate,
      input,
      result,
    } satisfies FirewallAuditRecord;
  },
);

/**
 * Projection relies on Client's retained verified sender, never host text or
 * a name lookup. A checked message with one post names it: an outgoing post,
 * or an incoming message or request. A gather, checked before its posts
 * exist, and a result or failure, which no single post carries, name none.
 */
function auditPost(entry: FirewallAuditEntry, message: Message | null) {
  if (message === null) {
    return Effect.succeed(null);
  }
  return entry.direction === "outgoing"
    ? outgoingPost(entry, message)
    : incomingPost(entry, message);
}

function outgoingPost(entry: FirewallAuditEntry, message: Message) {
  return Effect.gen(function* () {
    if (
      message.operation?.kind === "request" &&
      message.operation.op === "gather"
    ) {
      return null;
    }
    const intent = yield* decodeRuntimeValue(
      PostIntent,
      entry.canonicalCandidate,
    );
    if (intent.authorAgentId !== message.sender) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    return { authorAgentId: intent.authorAgentId, postId: intent.postId };
  });
}

function incomingPost(entry: FirewallAuditEntry, message: Message) {
  return Effect.gen(function* () {
    const item = yield* decodeRuntimeValue(
      InboundItem,
      entry.canonicalCandidate,
    );
    const postId = itemPostId(item);
    if (postId === undefined) {
      return null;
    }
    return yield* Schema.decodeUnknown(firewallAuditPost)({
      authorAgentId: message.sender,
      postId,
    }).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
      ),
    );
  });
}

/** The post an incoming item derives from; a result or failure has none. */
function itemPostId(item: InboundItem): string | undefined {
  switch (item.kind) {
    case "multicast":
      return item.message.postId;
    case "collectiveRequest":
      return item.postId;
    case "collectiveResult":
    case "operationFailed":
      return undefined;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}
