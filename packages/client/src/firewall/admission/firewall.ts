/** @file The firewall's installation, its outgoing admission, and the check of a certified incoming item. */

import { Effect, Option, Schema } from "effect";
import { createHash } from "node:crypto";
import type { AgentCard, VerifiedAgentCard } from "../../identity/cards.js";
import type { FirewallSendError } from "../outcome/index.js";
import { InboundItem } from "../../communication/collectives/inbound.js";
import {
  type AdmittedGather,
  type CollectiveAdmission,
  type GatherCandidate,
  readCollectiveValue,
} from "../../communication/collectives/index.js";
import {
  questionText,
  renderContent,
} from "../../communication/collectives/render.js";
import { SendError } from "../../communication/conversations/errors.js";
import {
  type BindHold,
  type EndpointEngine,
  type EngineSendInput,
  type PreparedSend,
  type ResolvedConversation,
  untilFresh,
} from "../../communication/conversations/index.js";
import { Content } from "../../communication/records/index.js";
import { PostId } from "../../communication/records/values.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  EndpointStoreError,
  type FirewallInboxEntry,
} from "../../communication/store/index.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import {
  CheckInputError,
  type DecisionProvider,
  type EnglishPolicySettings,
  type EnglishRule,
  type FirewallSettings,
  makeFirewall,
  type Message,
  type MessageContext,
  type MessageMiddleware,
} from "../evaluator/index.js";
import {
  agentAddressOf,
  assess,
  type CheckedMessage,
  conversationAddress,
  type DecodedRecord,
  decodeMessage,
  decodeRecord,
  type FirewallEnvironment,
  hashedId,
  postProjection,
  refusedSend,
  requestText,
} from "./firewall-checks.js";
import {
  decodeFirewallConfiguration,
  decodeFirewallInstallation,
  decodeFirewallRegistration,
  type FirewallConfiguration,
  type FirewallInstallation,
} from "./firewall-values.js";

// safer-arch-ignore file-implicit-boundary-module: Firewall composition and its admission worker share one immutable installation and evidence pipeline; this private implementation is exposed only through admission/index.ts.

/**
 * The post id a gather's question is rendered under before any of its posts
 * exist; the rendering does not show it.
 */
const unpostedRequest = Schema.decodeUnknown(PostId)(
  `pst_${"A".repeat(43)}`,
).pipe(Effect.orDie);

/** Code, facts and provider settings stay fixed; owner tools edit only English rules. */
export interface FirewallOptions {
  readonly mode: "guidance" | "enforcement";
  readonly incoming: readonly MessageMiddleware[];
  readonly outgoing: readonly MessageMiddleware[];
  readonly settings: FirewallSettings;
  readonly facts: MessageContext["facts"];
  readonly codeDigest: string;
  readonly maximumHistoryRecords?: number;
  readonly maximumConcurrentChecks?: number;
  readonly english?: {
    readonly fixedRules?: readonly EnglishRule[];
    readonly initialRules?: readonly EnglishRule[];
    readonly provider: DecisionProvider;
    readonly settings: EnglishPolicySettings;
  };
}

/** Builds an immutable chain from registrations already captured by policy composition. */
export const buildFirewall = Effect.fn("buildFirewall")(function* (
  options: FirewallOptions,
) {
  const configuration = yield* captureConfiguration(options);
  const { incoming, outgoing } = options;
  const metadata = yield* captureInstallation(
    configuration,
    options.settings,
    incoming,
    outgoing,
  );
  const firewall = yield* makeFirewall({
    incoming,
    outgoing,
    settings: metadata.settings,
  });
  const bytes = yield* encodeRuntimeValue(metadata).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
  return Object.freeze({
    configuration,
    metadata,
    configurationDigest: createHash("sha256").update(bytes).digest("hex"),
    firewall,
    permits: yield* Effect.makeSemaphore(configuration.maximumConcurrentChecks),
  });
});

/** Capture executable registration once so caller mutation cannot affect later rebuilds. */
export function captureRegistration(entry: MessageMiddleware) {
  return Effect.gen(function* () {
    const check = entry.check.bind(entry);
    const metadata = yield* decodeFirewallRegistration(
      registrationMetadata(entry),
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CheckInputError({ reason: "registration" })),
      ),
    );
    return Object.freeze({ ...metadata, check });
  }).pipe(Effect.withSpan("captureRegistration"));
}

/**
 * The firewall's part in the collective layer. Every post the agent authors
 * is checked as its own candidate and binds in the transaction that compares
 * the check's evidence. A gather is checked once; its admission commits in
 * the transaction that compares its evidence, and each request post binds
 * only against that admitted check. The advice an admitting check gives the
 * agent returns with the send.
 *
 * ```mermaid
 * flowchart LR
 *   D[Agent's send: multicast, all_gather, answer or gather] --> C[Capture local evidence]
 *   C --> F[Run full outgoing middleware chain]
 *   F --> A[Compare evidence atomically]
 *   A -->|post allowed| I[Take the layer's hold and bind the intent]
 *   A -->|gather allowed| G[Admit the operation; request posts bind against it]
 *   A -->|refused| E[Return send error and registered feedback]
 *   A -->|stale once| C
 * ```
 * @param environment The store, installation and local identity.
 * @param engine The engine whose binds the checks gate.
 * @returns The admission ports the collective layer is built with.
 */
export const collectiveAdmission = (
  environment: FirewallEnvironment,
  engine: Pick<
    EndpointEngine,
    "bindChecked" | "sendAdmitted" | "resolveConversation"
  >,
): CollectiveAdmission => ({
  bindPost: (input, hold) => bindPost(environment, engine, input, hold),
  admitGather: (candidate) => admitGather(environment, engine, candidate),
});

/**
 * Check and bind one authored post. The bound post carries the guidance of
 * the check that admitted it, whether or not it certifies.
 */
function bindPost<E>(
  environment: FirewallEnvironment,
  engine: Pick<EndpointEngine, "bindChecked">,
  input: EngineSendInput,
  hold: BindHold<E>,
) {
  return engine
    .bindChecked(
      input,
      (prepared: PreparedSend, terminal: boolean) =>
        checkPrepared(environment, prepared, terminal).pipe(
          Effect.map((checked) => ({
            completion: checked.completion,
            refusal: refusedSend(checked),
            admitted: checked.guidance,
          })),
        ),
      hold,
    )
    .pipe(
      Effect.map(({ certified, admitted }) => ({
        certified,
        guidance: admitted,
      })),
    );
}

/** Only the immutable certified candidate supplies author and recipient attribution. */
export const checkIncoming = (
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
  terminal = false,
): Effect.Effect<CheckedMessage, EndpointStoreError> =>
  environment.installed.permits
    .withPermits(1)(
      Effect.gen(function* () {
        const localAgentId = environment.localAgentCard.agentId;
        const evidence = yield* environment.store.readFirewallEvidence({
          beforeDelivery: entry.deliveryToken,
          conversation: entry.conversation,
          maximumRecords:
            environment.installed.configuration.maximumHistoryRecords,
        });
        const candidate =
          evidence.candidate === undefined
            ? undefined
            : yield* decodeRecord(evidence.candidate, localAgentId);
        const item = yield* decodeRuntimeValue(
          InboundItem,
          entry.canonicalItem,
        );
        const message =
          candidate === undefined
            ? undefined
            : yield* checkedIncomingProjection(item, candidate);
        return yield* assess(environment, {
          direction: "incoming",
          evidence,
          canonicalCandidate: entry.canonicalItem,
          ...(message === undefined ? {} : { message }),
          cards: candidate?.cards ?? [],
          terminal,
        });
      }),
    )
    .pipe(Effect.withSpan("checkIncoming"));

function registrationMetadata({
  id,
  revision,
  rules,
  provenance,
}: MessageMiddleware) {
  return {
    id,
    revision,
    rules,
    provenance: provenance ?? {
      format: "unavailable",
      data: "No descriptive provenance was declared.",
    },
  };
}

function captureConfiguration(
  options: FirewallOptions,
): Effect.Effect<FirewallConfiguration, CheckInputError> {
  return decodeFirewallConfiguration({
    mode: options.mode,
    facts: options.facts,
    codeDigest: options.codeDigest,
    maximumHistoryRecords: options.maximumHistoryRecords ?? 256,
    maximumConcurrentChecks: options.maximumConcurrentChecks ?? 4,
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "settings" })),
    ),
  );
}

function captureInstallation(
  configuration: FirewallConfiguration,
  settings: FirewallSettings,
  incoming: readonly MessageMiddleware[],
  outgoing: readonly MessageMiddleware[],
): Effect.Effect<FirewallInstallation, CheckInputError> {
  return decodeFirewallInstallation({
    configuration,
    settings,
    incoming: incoming.map(registrationMetadata),
    outgoing: outgoing.map(registrationMetadata),
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
}

/** The check permit covers capture and inference, never intent activation or protocol work. */
function checkPrepared(
  environment: FirewallEnvironment,
  prepared: PreparedSend,
  terminal: boolean,
): Effect.Effect<CheckedMessage, EndpointStoreError> {
  return environment.installed.permits
    .withPermits(1)(
      Effect.gen(function* () {
        const cards = prepared.membership.members;
        const localAgentId = environment.localAgentCard.agentId;
        const evidence = yield* environment.store.readFirewallEvidence({
          conversationId: prepared.intent.conversationId,
          conversation: yield* conversationAddress(cards, localAgentId),
          maximumRecords:
            environment.installed.configuration.maximumHistoryRecords,
        });
        const projection = yield* postProjection(
          prepared.intent,
          cards,
          localAgentId,
        );
        return yield* assess(environment, {
          direction: "outgoing",
          evidence,
          canonicalCandidate: prepared.canonicalIntent,
          message: projection.message,
          cards,
          terminal,
        });
      }),
    )
    .pipe(Effect.withSpan("checkOutgoing"));
}

/**
 * Check a gather, rechecking once on stale evidence, and return the sender
 * its request posts bind through with the advice its admitting check gave.
 * A store failure fails as `persistence-failed` before any post.
 */
function admitGather(
  environment: FirewallEnvironment,
  engine: Pick<EndpointEngine, "sendAdmitted" | "resolveConversation">,
  candidate: GatherCandidate,
): Effect.Effect<AdmittedGather, SendError | FirewallSendError> {
  return Effect.gen(function* () {
    const gather: GatherCheck = {
      candidate,
      canonicalCandidate: yield* encodeCanonical(
        Content,
        candidate.content,
      ).pipe(
        Effect.catchTag("ClientRepresentationError", () =>
          Effect.fail(new SendError({ reason: "content-invalid" })),
        ),
      ),
      conversation: yield* engine.resolveConversation(candidate.to),
    };
    const committed = yield* untilFresh((terminal) =>
      commitGather(environment, gather, terminal),
    );
    if (Option.isNone(committed)) {
      return yield* new SendError({ reason: "certification-unavailable" });
    }
    return yield* admittedSender(
      engine,
      committed.value.checked,
      committed.value.disposition,
    );
  }).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(new SendError({ reason: "persistence-failed" })),
    ),
    Effect.withSpan("admitGather"),
  );
}

/** Check a gather and commit the check as its admitted operation. */
function commitGather(
  environment: FirewallEnvironment,
  gather: GatherCheck,
  terminal: boolean,
) {
  return Effect.gen(function* () {
    const checked = yield* checkGather(environment, gather, terminal);
    const disposition = yield* environment.store.admitFirewallOperation(
      checked.completion,
      gather.canonicalCandidate,
    );
    return disposition === "stale" ? disposition : { checked, disposition };
  });
}

/** The sender an admitted gather's posts bind through and its check's advice, or the refusal of one withheld. */
function admittedSender(
  engine: Pick<EndpointEngine, "sendAdmitted">,
  checked: CheckedMessage,
  disposition: "admitted" | "withheld",
): Effect.Effect<AdmittedGather, FirewallSendError> {
  const { checkId } = checked.completion;
  return disposition === "admitted"
    ? Effect.succeed({
        sendRequest: (input: EngineSendInput) =>
          engine.sendAdmitted(input, checkId),
        guidance: checked.guidance,
      })
    : Effect.fail(refusedSend(checked));
}

/** A gather's request content and the conversation of the address it asks. */
interface GatherCheck {
  readonly candidate: GatherCandidate;
  readonly canonicalCandidate: Uint8Array;
  readonly conversation: ResolvedConversation;
}

/**
 * Check a gather once, as the question every member will read, attributed to
 * the members it asks and assessed against the recent window of the
 * conversation its address names.
 */
function checkGather(
  environment: FirewallEnvironment,
  gather: GatherCheck,
  terminal: boolean,
): Effect.Effect<CheckedMessage, EndpointStoreError> {
  return environment.installed.permits
    .withPermits(1)(
      Effect.gen(function* () {
        const evidence = yield* environment.store.readFirewallEvidence({
          conversationId: gather.conversation.conversationId,
          conversation: gather.conversation.address,
          maximumRecords:
            environment.installed.configuration.maximumHistoryRecords,
        });
        return yield* assess(environment, {
          direction: "outgoing",
          evidence,
          canonicalCandidate: gather.canonicalCandidate,
          message: yield* gatherMessage(environment.localAgentCard, gather),
          cards: gather.conversation.memberCards,
          terminal,
        });
      }),
    )
    .pipe(Effect.withSpan("checkGather"));
}

/** A gather as the question each member reads, sent by the local agent to every member. */
function gatherMessage(local: VerifiedAgentCard, gather: GatherCheck) {
  return Effect.gen(function* () {
    const value = yield* readCollectiveValue(gather.candidate.content).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchTag("CollectivePartInvalidError", () =>
        Effect.succeed(undefined),
      ),
    );
    if (value?.kind !== "operation" || value.op !== "gather") {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    return yield* decodeMessage({
      id: hashedId(`${local.agentId}:${value.id}`),
      sender: local.agentId,
      recipients: gather.conversation.memberCards
        .map((card) => card.agentId)
        .filter((id) => id !== local.agentId),
      text: yield* requestText({
        kind: "collectiveRequest",
        op: "gather",
        id: value.id,
        postId: yield* unpostedRequest,
        from: yield* agentAddressOf(local),
        to: gather.conversation.address,
        question: questionText(gather.candidate.content),
        requestedSchema: value.requestedSchema,
        deadlineAt: value.deadlineAt,
      }),
      operation: {
        kind: "request",
        op: "gather",
        id: value.id,
        deadlineAt: value.deadlineAt,
      },
    });
  }).pipe(Effect.withSpan("gatherMessage"));
}

/**
 * The checked message of an item derived from a certified record: the
 * record's own projection, after the item is confirmed to be that record's.
 */
function checkedIncomingProjection(
  item: InboundItem,
  candidate: DecodedRecord,
): Effect.Effect<Message, EndpointStoreError> {
  const same =
    item.kind === "multicast"
      ? sameMulticast(item, candidate)
      : item.kind === "collectiveRequest" && sameRequest(item, candidate);
  return same
    ? Effect.succeed(candidate.message)
    : Effect.fail(new EndpointStoreError({ reason: "corrupt" }));
}

function sameMulticast(
  item: Extract<InboundItem, { readonly kind: "multicast" }>,
  candidate: DecodedRecord,
): boolean {
  const plainMessage =
    candidate.supported && candidate.message.operation === undefined;
  return (
    plainMessage &&
    samePost(item.message, candidate) &&
    renderContent(item.message.content) === candidate.message.text &&
    sameAudience(item.message, candidate.cards)
  );
}

function sameRequest(
  item: Extract<InboundItem, { readonly kind: "collectiveRequest" }>,
  candidate: DecodedRecord,
): boolean {
  const operation = candidate.message.operation;
  const sameOperation =
    operation?.kind === "request" &&
    operation.id === item.id &&
    operation.op === item.op;
  return (
    sameOperation &&
    samePost({ postId: item.postId, sender: item.from }, candidate)
  );
}

function samePost(
  post: { readonly postId: string; readonly sender: string },
  candidate: DecodedRecord,
): boolean {
  return (
    post.postId === candidate.intent.postId && post.sender === candidate.author
  );
}

function sameAudience(
  message: Extract<InboundItem, { kind: "multicast" }>["message"],
  cards: readonly AgentCard[],
): boolean {
  if (message.kind === "direct") {
    return cards.length === 2;
  }
  const expected = cards.map((card) => `agent:${card.agentName}`);
  return (
    expected.length === message.members.length &&
    message.members.every((member) => expected.includes(member))
  );
}
