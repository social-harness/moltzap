/** @file The items an endpoint delivers to its host: messages and collective requests, results and failures. */

import { Schema } from "effect";
import { exactStruct } from "../../encoding/exact.js";
import { withheldText } from "../../firewall/outcome/index.js";
import { AgentView } from "../../identity/cards.js";
import { InboundMessage } from "../conversations/message.js";
import {
  MessageAddressInput,
  PostId,
  wellFormedString,
} from "../records/values.js";
import {
  AnswerContent,
  collectiveClosure,
  CollectiveId,
  EpochMillis,
  RequestedSchema,
} from "./contracts.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

/**
 * A multicast delivered to this endpoint. The message content is the post's
 * content without the collective layer's part.
 */
const multicastItem = exactStruct({
  kind: Schema.Literal("multicast"),
  message: InboundMessage,
});

/** Which collecting operation an item belongs to. */
const collectingOp = Schema.Literal("gather", "all_gather");

/**
 * A question another agent asked this one. `postId` is the certified request
 * post's and `to` the conversation it arrived in: the requester's `agent:`
 * address for a gather, the group's `group:` address for an all_gather. The
 * member answers once with a `collectiveResponse` sent to `to`.
 */
const collectiveRequestItem = exactStruct({
  kind: Schema.Literal("collectiveRequest"),
  op: collectingOp,
  id: CollectiveId,
  postId: PostId,
  from: AgentView,
  to: MessageAddressInput,
  question: wellFormedString,
  requestedSchema: RequestedSchema,
  deadlineAt: EpochMillis,
});

/**
 * One member's outcome in a completed gather or all_gather, discriminated by
 * `kind`. `no-answer` covers every member that did not answer: one whose
 * request post was refused or not certified in time, and one silent at the
 * deadline. `withheld` replaces an answer the endpoint's firewall withheld
 * from the runtime; only the local projection carries it, never the shared
 * result.
 */
const memberOutcome = Schema.Union(
  exactStruct({ kind: Schema.Literal("answered"), content: AnswerContent }),
  exactStruct({ kind: Schema.Literal("declined") }),
  exactStruct({ kind: Schema.Literal("invalid"), reason: Schema.String }),
  exactStruct({ kind: Schema.Literal("no-answer") }),
  withheldText,
);
/**
 * One member's outcome after the local firewall limits the text the host may see.
 * @useDeclaredType
 */
export type CollectiveMemberOutcome = typeof memberOutcome.Type;

/**
 * The result of a gather this endpoint started, or of an all_gather this
 * endpoint started or was asked: exactly one outcome per member, in member
 * order. `to` is the address the operation named. Every member's all_gather
 * result is built from exactly the answers the requester's close lists.
 * Each endpoint derives the same shared result before its local firewall
 * projection. The question is the requester's text, or `withheld` where
 * this endpoint's firewall withheld the request.
 */
const collectiveResultItem = exactStruct({
  kind: Schema.Literal("collectiveResult"),
  op: collectingOp,
  id: CollectiveId,
  ...collectiveClosure.fields,
  to: MessageAddressInput,
  question: Schema.Union(wellFormedString, withheldText),
  outcomes: Schema.NonEmptyArray(
    exactStruct({ member: AgentView, outcome: memberOutcome }),
  ),
});

/**
 * An all_gather close refused before binding. The operation already started,
 * so its failure arrives through the inbox. A bound close remains pending
 * until certification and cannot produce this item.
 */
const operationFailedItem = exactStruct({
  kind: Schema.Literal("operationFailed"),
  id: CollectiveId,
  to: MessageAddressInput,
  error: Schema.String,
});

/**
 * One inbound item, discriminated by `kind`. The endpoint consumes the
 * collective layer's protocol posts, posts whose collective part is malformed
 * or duplicated, and multicasts that carry nothing besides that part; every
 * other certified post becomes one item, and the endpoint itself emits
 * results and failures.
 */
export const InboundItem = Schema.Union(
  multicastItem,
  collectiveRequestItem,
  collectiveResultItem,
  operationFailedItem,
).annotations({
  identifier: "InboundItem",
});
/**
 * Host-visible peer content or a result produced by the local daemon.
 * @useDeclaredType
 */
export type InboundItem = typeof InboundItem.Type;

/**
 * The result delivered when a gather or all-gather completes.
 * @useDeclaredType
 */
export type CollectiveResultItem = Extract<
  InboundItem,
  { readonly kind: "collectiveResult" }
>;

/** Archived run ledgers map approval refusals to the current evidence hold. */
const archivedWithheldText = exactStruct({
  ...withheldText.fields,
  reason: Schema.transform(
    Schema.Union(
      withheldText.fields.reason,
      Schema.Literal("approval-required"),
    ),
    withheldText.fields.reason,
    {
      strict: true,
      decode: (reason) =>
        reason === "approval-required"
          ? ("unresolved-evidence" as const)
          : reason,
      encode: (reason) => reason,
    },
  ),
});

/**
 * An inbound item as a history export holds it. Archived run ledgers decode
 * independently of live endpoint stores, so a collective result's withheld
 * text may also carry an `approval-required` refusal.
 */
export const historyExportItem = Schema.Union(
  InboundItem,
  exactStruct({
    ...collectiveResultItem.fields,
    question: Schema.Union(wellFormedString, archivedWithheldText),
    outcomes: Schema.NonEmptyArray(
      exactStruct({
        member: AgentView,
        outcome: Schema.Union(memberOutcome, archivedWithheldText),
      }),
    ),
  }),
).annotations({ identifier: "HistoryExportItem" });

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
