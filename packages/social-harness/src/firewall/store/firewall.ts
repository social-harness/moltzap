/** @file Retained local checks, editable policies and assessment queue transitions. */

import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import { Effect, Schema, Struct } from "effect";

import type {
  FirewallActivation,
  FirewallAuditEntry,
  FirewallCommit,
  FirewallCompletion,
  FirewallInboxEntry,
  FirewallLocalAdmission,
} from "./types.js";
import {
  EndpointStoreError,
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  requireBytes,
  requireSameBytes,
  requireSameOptionalBytes,
  requireText,
  storeOperation,
  transaction,
} from "../../communication/store/database/index.js";
import { decodeRuntimeValue } from "../../communication/store/index.js";
import { DeliveryToken } from "../../communication/store/types.js";
import { exactStruct } from "../../encoding/exact.js";
import { AgentView } from "../../identity/cards.js";
import {
  type DecidingRule,
  decidingRules,
  type FirewallCheck,
  firewallCheckSchema,
  Message,
  MessageContext,
  textCheckId,
  textPolicyFormat,
} from "../check.js";
import {
  firewallDecisionsSchema,
  firewallInstallationSchema,
} from "../config.js";
const ruleIds = Schema.parseJson(Schema.Array(Schema.NonEmptyString));
const activationRow = Schema.Struct({
  sequence: Schema.Int,
  time: Schema.Int,
  activeRevision: Schema.String,
  addedRuleIds: ruleIds,
  removedRuleIds: ruleIds,
});
const auditDisposition = Schema.Literal("admitted", "withheld");
/**
 * A held item is never requeued. Provenance is bound with the item: the same token cannot later
 * carry different private facts. An item is anchored at the newest record
 * certified when it is queued, so a local item's evidence precedes every
 * record certified after it, as the runtime is shown them.
 */
export function queueFirewallItem(
  item: Omit<FirewallInboxEntry, "sequence">,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    requireText(item.conversation);
    requireBytes(item.canonicalItem);
    const prior = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT conversation, canonical_item, canonical_provenance FROM firewall_incoming WHERE delivery_token = ?",
      [item.deliveryToken],
    ))[0];
    if (prior !== undefined) {
      requireSameBytes(readBytes(prior, "canonical_item"), item.canonicalItem);
      requireSameOptionalBytes(
        readOptionalBytes(prior, "canonical_provenance"),
        item.canonicalProvenance,
      );
      if (readText(prior, "conversation") !== item.conversation) {
        return yield* new EndpointStoreError({ reason: "conflict" });
      }
      return;
    }
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "INSERT INTO firewall_incoming (delivery_token, conversation, canonical_item, canonical_provenance, anchor) SELECT ?, ?, ?, ?, COALESCE(MAX(rowid), 0) FROM certified_records",
      [
        item.deliveryToken,
        item.conversation,
        item.canonicalItem,
        item.canonicalProvenance ?? null,
      ],
    );
  }).pipe(storeOperation, Effect.withSpan("queueFirewallItem"));
}
/** One unsettled predecessor per conversation is eligible for checking. */
export function readNextPendingMessages(): Effect.Effect<
  readonly FirewallInboxEntry[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
    SELECT item.sequence, item.delivery_token, item.conversation, item.canonical_item,
      item.canonical_provenance
    FROM firewall_incoming item
    WHERE item.disposition = 'pending' AND NOT EXISTS (
      SELECT 1 FROM firewall_incoming earlier
      WHERE earlier.conversation = item.conversation
        AND earlier.disposition = 'pending' AND earlier.sequence < item.sequence
    ) ORDER BY item.sequence LIMIT 32
  `,
      [],
    )).map(queuedEntry);
  }).pipe(storeOperation, Effect.withSpan("readNextPendingMessages"));
}
/** Restart recovery visits every private item, including successors behind a held frontier. */
export function readPendingFirewallItems(
  after: number,
): Effect.Effect<
  readonly FirewallInboxEntry[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    if (!Number.isSafeInteger(after) || after < 0) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
      SELECT sequence, delivery_token, conversation, canonical_item, canonical_provenance
      FROM firewall_incoming
      WHERE disposition = 'pending' AND sequence > ?
      ORDER BY sequence LIMIT 32
    `,
      [after],
    )).map(queuedEntry);
  }).pipe(storeOperation, Effect.withSpan("readPendingFirewallItems"));
}
/** Missing policy means initial rules have never been seeded, distinct from an empty list. */
export function readFirewallPolicy(): Effect.Effect<
  Uint8Array | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT canonical_rules FROM firewall_policy WHERE singleton = 1",
      [],
    ))[0];
    return row === undefined ? undefined : readBytes(row, "canonical_rules");
  }).pipe(storeOperation, Effect.withSpan("readFirewallPolicy"));
}
/** The editable document and its activation either both commit or neither does. */
export function writeFirewallPolicy(
  rules: Uint8Array,
  activation?: FirewallActivation,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    requireBytes(rules);
    yield* transaction(
      Effect.gen(function* () {
        yield* database.unsafe<Readonly<Record<string, unknown>>>(
          `INSERT INTO firewall_policy (singleton, canonical_rules) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET canonical_rules = excluded.canonical_rules`,
          [rules],
        );
        if (activation !== undefined) {
          yield* database.unsafe<Readonly<Record<string, unknown>>>(
            `INSERT INTO firewall_activations
        (activated_at, active_revision, added_rule_ids, removed_rule_ids)
        VALUES (?, ?, ?, ?)`,
            [
              activation.time,
              activation.activeRevision,
              Schema.encodeSync(ruleIds)(activation.addedRuleIds),
              Schema.encodeSync(ruleIds)(activation.removedRuleIds),
            ],
          );
        }
      }),
    );
  }).pipe(storeOperation, Effect.withSpan("writeFirewallPolicy"));
}
/** Recent edits preserve activation order when timestamps coincide. */
export function readFirewallActivations(request: { readonly since?: number }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const since = request.since ?? 0;
    if (!Number.isSafeInteger(since) || since < 0) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    const query = SqlSchema.findAll({
      Request: Schema.Int,
      Result: activationRow,
      execute: (after) =>
        sql.unsafe(
          "SELECT sequence,activated_at AS time,active_revision AS activeRevision,added_rule_ids AS addedRuleIds,removed_rule_ids AS removedRuleIds FROM firewall_activations WHERE activated_at>=? ORDER BY activated_at DESC,sequence DESC LIMIT 100",
          [after],
        ),
    });
    const rows = yield* query(since).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
      ),
    );
    return rows.map(({ sequence, ...activation }) => ({
      sequence,
      activation,
    }));
  }).pipe(storeOperation, Effect.withSpan("readFirewallActivations"));
}
/** Completion time includes checks that started before a caller's previous poll. */
export function readFirewallDecisions(since = 0) {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    if (!Number.isSafeInteger(since) || since < 0) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT rowid AS sequence, check_id, direction,
    canonical_candidate, canonical_input, canonical_result, disposition, decided_at
    FROM firewall_checks WHERE decided_at >= ?
    ORDER BY decided_at DESC, rowid DESC LIMIT 100`,
      [since],
    )).map((row) => ({
      ...auditEntry(row),
      time: readInteger(row, "decided_at"),
    }));
  }).pipe(storeOperation, Effect.withSpan("readFirewallDecisions"));
}
/** Local result decisions and evidence settle with the caller's host publication transaction. */
export function settleLocalItem(
  admission: FirewallLocalAdmission,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const { deliveryToken } = admission.item;
    requireText(admission.evidence.conversation);
    requireBytes(admission.evidence.canonicalEntry);
    yield* requireQueueFrontier(deliveryToken, admission.queuedItem);
    for (const completion of admission.completions) {
      if (completion.direction !== "incoming") {
        return yield* new EndpointStoreError({ reason: "conflict" });
      }
      requireSameBytes(completion.canonicalCandidate, admission.queuedItem);
      yield* saveCheckDecision(completion);
    }
    yield* markAnswers(admission.answers, admission.item.deliveryToken);
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `INSERT INTO firewall_local_evidence (conversation, anchor, canonical_entry)
 SELECT ?, anchor, ? FROM firewall_incoming WHERE delivery_token = ?`,
      [
        admission.evidence.conversation,
        admission.evidence.canonicalEntry,
        deliveryToken,
      ],
    );
    yield* settleQueuedItem(deliveryToken, "admitted");
  }).pipe(storeOperation, Effect.withSpan("settleLocalItem"));
}
/** A settled item cannot be offered for reassessment after restart. */
export function settleQueuedItem(
  deliveryToken: DeliveryToken,
  disposition: "admitted" | "withheld",
  checkId?: string,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "UPDATE firewall_incoming SET disposition = ?, check_id = ? WHERE delivery_token = ?",
      [disposition, checkId ?? null, deliveryToken],
    );
  }).pipe(storeOperation, Effect.withSpan("settleQueuedItem"));
}
/** A conversation commits its unsettled predecessor before later host items. */
export function requireQueueFrontier(
  deliveryToken: DeliveryToken,
  canonicalItem: Uint8Array,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const queued = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
      SELECT conversation, sequence, canonical_item FROM firewall_incoming
      WHERE delivery_token = ? AND disposition = 'pending'
    `,
      [deliveryToken],
    ))[0];
    if (queued === undefined) {
      return yield* new EndpointStoreError({ reason: "conflict" });
    }
    requireSameBytes(readBytes(queued, "canonical_item"), canonicalItem);
    const predecessor = (yield* database.unsafe<
      Readonly<Record<string, unknown>>
    >(
      `
      SELECT 1 AS pending FROM firewall_incoming
      WHERE conversation = ? AND sequence < ? AND disposition = 'pending' LIMIT 1
    `,
      [readText(queued, "conversation"), readInteger(queued, "sequence")],
    ))[0];
    if (predecessor !== undefined) {
      return yield* new EndpointStoreError({ reason: "conflict" });
    }
  }).pipe(storeOperation, Effect.withSpan("requireQueueFrontier"));
}
/** Saves one completed assessment; interruption before completion leaves no audit row. */
export function saveCheckDecision(
  completion: FirewallCompletion,
): Effect.Effect<FirewallCommit, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    requireText(completion.checkId);
    requireBytes(completion.canonicalCandidate);
    requireBytes(completion.canonicalInput);
    requireBytes(completion.canonicalResult);
    const disposition = completion.admit ? "admitted" : "withheld";
    const prior = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT direction,canonical_candidate,canonical_input,canonical_result,disposition FROM firewall_checks WHERE check_id=?",
      [completion.checkId],
    ))[0];
    if (prior !== undefined) {
      if (
        readText(prior, "direction") !== completion.direction ||
        readText(prior, "disposition") !== disposition
      ) {
        return yield* new EndpointStoreError({ reason: "conflict" });
      }
      requireSameBytes(
        readBytes(prior, "canonical_candidate"),
        completion.canonicalCandidate,
      );
      requireSameBytes(
        readBytes(prior, "canonical_input"),
        completion.canonicalInput,
      );
      requireSameBytes(
        readBytes(prior, "canonical_result"),
        completion.canonicalResult,
      );
      return disposition;
    }
    yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "INSERT INTO firewall_checks(check_id,direction,canonical_candidate,canonical_input,canonical_result,disposition,decided_at) VALUES(?,?,?,?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER))",
      [
        completion.checkId,
        completion.direction,
        completion.canonicalCandidate,
        completion.canonicalInput,
        completion.canonicalResult,
        disposition,
      ],
    );
    return disposition;
  }).pipe(storeOperation, Effect.withSpan("saveCheckDecision"));
}
/** Expiry retires a queued message without fabricating a policy assessment. */
export function retireQueuedItem(
  token: DeliveryToken,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "UPDATE firewall_incoming SET disposition='withheld' WHERE delivery_token=? AND disposition='pending' RETURNING sequence",
      [token],
    );
    if (rows.length !== 1) {
      return yield* new EndpointStoreError({ reason: "not-found" });
    }
  }).pipe(storeOperation, Effect.withSpan("retireQueuedItem"));
}
/**
 * Returns retained decisions without message content, private inputs,
 * diagnostics or rule text. Includes registered advice only for rules that
 * determined the decision.
 */
export function readDecisions(request: { readonly since?: number }) {
  return Effect.gen(function* () {
    const entries = yield* readFirewallDecisions(request.since);
    const rows = yield* Effect.forEach(
      entries,
      (entry) => decisionRows(entry),
      {
        concurrency: 1,
      },
    );
    return yield* Schema.decodeUnknown(firewallDecisionsSchema)({
      decisions: rows.flat(),
      activations: (yield* readFirewallActivations(request)).map(
        (entry) => entry.activation,
      ),
    });
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
    Effect.withSpan("readDecisions"),
  );
}
/** Associates each retained answer with the saved result view that decided its visibility. */
function markAnswers(
  answers: FirewallLocalAdmission["answers"],
  deliveryToken: DeliveryToken,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const answer of answers) {
      requireText(answer.recordHash);
      const rows = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "INSERT INTO firewall_answers(conversation_id,record_hash,admitted,delivery_token) SELECT conversation_id,record_hash,?,? FROM certified_records WHERE record_hash=? ON CONFLICT(conversation_id,record_hash) DO UPDATE SET admitted=excluded.admitted,delivery_token=excluded.delivery_token RETURNING record_hash",
        [answer.admitted ? 1 : 0, deliveryToken, answer.recordHash],
      );
      if (rows.length !== 1) {
        return yield* new EndpointStoreError({ reason: "conflict" });
      }
    }
  }).pipe(storeOperation);
}
function auditEntry(
  row: Readonly<Record<string, unknown>>,
): FirewallAuditEntry {
  const canonicalResult = readBytes(row, "canonical_result");
  return {
    sequence: readInteger(row, "sequence"),
    checkId: readText(row, "check_id"),
    direction: Schema.decodeUnknownSync(Schema.Literal("incoming", "outgoing"))(
      readText(row, "direction"),
    ),
    canonicalCandidate: readBytes(row, "canonical_candidate"),
    canonicalInput: readBytes(row, "canonical_input"),
    disposition: Schema.decodeUnknownSync(auditDisposition)(
      readText(row, "disposition"),
    ),
    canonicalResult,
  };
}
function queuedEntry(
  row: Readonly<Record<string, unknown>>,
): FirewallInboxEntry {
  const canonicalProvenance = readOptionalBytes(row, "canonical_provenance");
  return {
    sequence: readInteger(row, "sequence"),
    deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
      readText(row, "delivery_token"),
    ),
    conversation: readText(row, "conversation"),
    canonicalItem: readBytes(row, "canonical_item"),
    ...(canonicalProvenance === undefined ? {} : { canonicalProvenance }),
  };
}
/** A missing projected message records an unsupported candidate without inventing attribution. */
const firewallAuditInput = exactStruct({
  configurationDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  installation: firewallInstallationSchema,
  context: MessageContext,
  agents: Schema.Array(AgentView),
  message: Schema.NullOr(Message),
});
/**
 * A check as the store retains it: every field except the decision-provider
 * traces, which stay in memory with the code that produced the check.
 */
export const withoutTraces = (check: FirewallCheck) => ({
  ...check,
  checks: check.checks.map((middleware) => Struct.omit(middleware, "trace")),
});
/**
 * Opaque retained bytes are interpreted only by their Client delivery owner.
 * A retained result that holds provider traces decodes without them.
 */
export const decodeFirewallAuditEntry = Effect.fn("decodeFirewallAuditEntry")(
  function* (entry: FirewallAuditEntry) {
    const input = yield* decodeRuntimeValue(
      firewallAuditInput,
      entry.canonicalInput,
    );
    const result = withoutTraces(
      yield* decodeRuntimeValue(firewallCheckSchema, entry.canonicalResult),
    );
    return {
      checkId: entry.checkId,
      direction: entry.direction,
      disposition: entry.disposition,
      candidate: entry.canonicalCandidate,
      input,
      result,
    };
  },
);
function decisionRows(
  entry: FirewallAuditEntry & {
    readonly time: number;
  },
) {
  return decodeFirewallAuditEntry(entry).pipe(
    Effect.flatMap((check) =>
      ruleOrigin(check.input.installation[check.direction]).pipe(
        Effect.flatMap((origin) => projectDecision(check, entry.time, origin)),
      ),
    ),
  );
}
type DecodedCheck = Effect.Effect.Success<
  ReturnType<typeof decodeFirewallAuditEntry>
>;
type DecodedResult = DecodedCheck["result"];
type DecisionRow = (typeof firewallDecisionsSchema.Type.decisions)[number];
type Registration = DecodedCheck["input"]["installation"]["incoming"][number];
const textProvenance = Schema.parseJson(
  Schema.Struct({
    fixedRuleIds: Schema.Array(Schema.String),
  }),
);
type RuleOrigin = (
  rule: DecidingRule,
) => Pick<DecisionRow["decidedBy"][number], "from">;
function projectDecision(
  check: DecodedCheck,
  time: number,
  origin: RuleOrigin,
) {
  const result = check.result;
  const message = check.input.message;
  const peers =
    message === null ? [null] : decisionPeers(message, check.direction);
  const rules = decisionRules(
    result,
    check.input.installation[check.direction],
    origin,
  );
  return Effect.forEach(
    peers,
    (peerAgentId) => {
      const peer =
        peerAgentId === null
          ? null
          : check.input.agents.find((agent) => agent.agentId === peerAgentId);
      return peer === undefined
        ? Effect.fail(new EndpointStoreError({ reason: "corrupt" }))
        : Effect.succeed({
            checkId: check.checkId,
            time,
            direction: check.direction,
            peer,
            outcome: result.judgment,
            disposition: check.disposition,
            ...rules,
            activeRevision: check.input.configurationDigest,
          });
    },
    { concurrency: 1 },
  );
}
function decisionRules(
  result: DecodedResult,
  registrations: readonly Registration[],
  origin: RuleOrigin,
) {
  const checkedRuleIds = [
    ...new Set(
      result.checks.flatMap((middleware) =>
        middleware.findings.map((finding) => finding.ruleId),
      ),
    ),
  ];
  const deciding = decidingRules(result.reason, registrations, result.checks);
  const text = new Set(
    registrations
      .filter((entry) => entry.provenance.format === textPolicyFormat)
      .map((entry) => entry.id),
  );
  const cause = decisionCause(result, deciding, text);
  const decidedBy = deciding.map((rule) => ({
    ruleId: rule.ruleId,
    ...origin(rule),
    ...(rule.advice === undefined ? {} : { advice: rule.advice }),
  }));
  return { cause, decidedBy, checkedRuleIds };
}
/** Retained installation provenance distinguishes fixed, editable and code rules. */
function ruleOrigin(registrations: readonly Registration[]) {
  return Effect.gen(function* () {
    const text = registrations.find(
      (entry) =>
        entry.id === textCheckId &&
        entry.provenance.format === textPolicyFormat,
    );
    const recorded =
      text === undefined
        ? { fixedRuleIds: [] }
        : yield* Schema.decodeUnknown(textProvenance)(text.provenance.data);
    const fixed = new Set(recorded.fixedRuleIds);
    return (rule: DecidingRule): ReturnType<RuleOrigin> => {
      if (rule.middlewareId !== text?.id) {
        return { from: "code" };
      }
      return fixed.has(rule.ruleId) ? { from: "fixed" } : { from: "editable" };
    };
  });
}
function decisionCause(
  result: DecodedResult,
  deciding: readonly DecidingRule[],
  text: ReadonlySet<string>,
): DecisionRow["cause"] {
  const first =
    deciding.find((rule) => text.has(rule.middlewareId)) ?? deciding[0];
  if (first === undefined) {
    return emptyCause(result);
  }
  if (first.finding === "unavailable") {
    return "unavailable";
  }
  if (!text.has(first.middlewareId)) {
    return "code";
  }
  return first.finding === "uncertain" ? "uncertain" : "judgment";
}
function emptyCause(result: DecodedResult): DecisionRow["cause"] {
  if (
    result.reason === "check-unavailable" &&
    result.checks.some((check) => check.status === "unavailable")
  ) {
    return "unavailable";
  }
  return result.judgment === "allow" ? "default" : "endpoint";
}
/** Results and failures name no peer because the endpoint produces their text. */
function decisionPeers(
  message: NonNullable<DecodedCheck["input"]["message"]>,
  direction: "incoming" | "outgoing",
): ReadonlyArray<string | null> {
  if (direction === "outgoing") {
    return message.recipients;
  }
  const kind = message.operation?.kind;
  return kind === "result" || kind === "failure" ? [null] : [message.sender];
}
