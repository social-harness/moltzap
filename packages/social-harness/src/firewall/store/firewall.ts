/** @file Retained local checks, editable policies and assessment queue transitions. */

import type { DatabaseSync } from "node:sqlite";

import { Effect, Schema, Struct } from "effect";

import type {
  FirewallActivation,
  FirewallAttempt,
  FirewallAuditEntry,
  FirewallCommit,
  FirewallCompletion,
  FirewallInboxEntry,
  FirewallLocalAdmission,
  FirewallStore,
} from "./types.js";

import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  requireBytes,
  requireSameBytes,
  requireSameOptionalBytes,
  requireText,
  StoreSignal,
  transaction,
} from "../../communication/store/database/index.js";
import {
  decodeRuntimeValue,
  EndpointStoreError,
} from "../../communication/store/index.js";
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
  textPolicyFormat,
} from "../check.js";
import {
  firewallDecisionsSchema,
  firewallInstallationSchema,
} from "../config.js";

const auditDisposition = Schema.Literal(
  "checking",
  "interrupted",
  "admitted",
  "withheld",
);

/**
 * A held item is never requeued. Provenance is bound with the item: the same token cannot later
 * carry different private facts. An item is anchored at the newest record
 * certified when it is queued, so a local item's evidence precedes every
 * record certified after it, as the runtime is shown them.
 */
export function queueFirewallItem(
  database: DatabaseSync,
  item: Omit<FirewallInboxEntry, "sequence">,
): void {
  requireText(item.conversation);
  requireBytes(item.canonicalItem);
  const prior = database
    .prepare(
      "SELECT conversation, canonical_item, canonical_provenance FROM firewall_incoming WHERE delivery_token = ?",
    )
    .get(item.deliveryToken);
  if (prior !== undefined) {
    requireSameBytes(readBytes(prior, "canonical_item"), item.canonicalItem);
    requireSameOptionalBytes(
      readOptionalBytes(prior, "canonical_provenance"),
      item.canonicalProvenance,
    );
    if (readText(prior, "conversation") !== item.conversation) {
      throw new StoreSignal("conflict");
    }
    return;
  }
  database
    .prepare(
      "INSERT INTO firewall_incoming (delivery_token, conversation, canonical_item, canonical_provenance, anchor) SELECT ?, ?, ?, ?, COALESCE(MAX(rowid), 0) FROM certified_records",
    )
    .run(
      item.deliveryToken,
      item.conversation,
      item.canonicalItem,
      item.canonicalProvenance ?? null,
    );
}

/** One unsettled predecessor per conversation is eligible for checking. */
export function readFirewallFrontiers(
  database: DatabaseSync,
): readonly FirewallInboxEntry[] {
  return database
    .prepare(`
    SELECT item.sequence, item.delivery_token, item.conversation, item.canonical_item,
      item.canonical_provenance
    FROM firewall_incoming item
    WHERE item.disposition = 'pending' AND NOT EXISTS (
      SELECT 1 FROM firewall_incoming earlier
      WHERE earlier.conversation = item.conversation
        AND earlier.disposition = 'pending' AND earlier.sequence < item.sequence
    ) ORDER BY item.sequence LIMIT 32
  `)
    .all()
    .map(queuedEntry);
}

/** Restart recovery visits every private item, including successors behind a held frontier. */
export function readPendingFirewallItems(
  database: DatabaseSync,
  after: number,
): readonly FirewallInboxEntry[] {
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`
      SELECT sequence, delivery_token, conversation, canonical_item, canonical_provenance
      FROM firewall_incoming
      WHERE disposition = 'pending' AND sequence > ?
      ORDER BY sequence LIMIT 32
    `)
    .all(after)
    .map(queuedEntry);
}

/** Missing policy means initial rules have never been seeded, distinct from an empty list. */
export function readFirewallPolicy(
  database: DatabaseSync,
): Uint8Array | undefined {
  const row = database
    .prepare("SELECT canonical_rules FROM firewall_policy WHERE singleton = 1")
    .get();
  return row === undefined ? undefined : readBytes(row, "canonical_rules");
}

/** The editable document and its activation either both commit or neither does. */
export function writeFirewallPolicy(
  database: DatabaseSync,
  rules: Uint8Array,
  activation?: FirewallActivation,
): void {
  requireBytes(rules);
  transaction(database, () => {
    database
      .prepare(`INSERT INTO firewall_policy (singleton, canonical_rules) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET canonical_rules = excluded.canonical_rules`)
      .run(rules);
    if (activation !== undefined) {
      database
        .prepare(`INSERT INTO firewall_activations
        (activated_at, active_revision, added_rule_ids, removed_rule_ids)
        VALUES (?, ?, ?, ?)`)
        .run(
          activation.time,
          activation.activeRevision,
          JSON.stringify(activation.addedRuleIds),
          JSON.stringify(activation.removedRuleIds),
        );
    }
  });
}

/** Recent edits preserve activation order when timestamps coincide. */
export function readFirewallActivations(
  database: DatabaseSync,
  request: { readonly since?: number },
) {
  const since = request.since ?? 0;
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`SELECT sequence, activated_at, active_revision,
    added_rule_ids, removed_rule_ids FROM firewall_activations
    WHERE activated_at >= ? ORDER BY activated_at DESC, sequence DESC LIMIT 100`)
    .all(since)
    .map((row) => ({
      sequence: readInteger(row, "sequence"),
      activation: {
        time: readInteger(row, "activated_at"),
        activeRevision: readText(row, "active_revision"),
        addedRuleIds: Schema.decodeUnknownSync(
          Schema.parseJson(Schema.Array(Schema.NonEmptyString)),
        )(readText(row, "added_rule_ids")),
        removedRuleIds: Schema.decodeUnknownSync(
          Schema.parseJson(Schema.Array(Schema.NonEmptyString)),
        )(readText(row, "removed_rule_ids")),
      },
    }));
}

/** Completion time includes checks that started before a caller's previous poll. */
export function readFirewallDecisions(database: DatabaseSync, since = 0) {
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`SELECT rowid AS sequence, check_id, direction,
    canonical_candidate, canonical_input, canonical_result, disposition, decided_at
    FROM firewall_checks WHERE decided_at >= ?
    ORDER BY decided_at DESC, rowid DESC LIMIT 100`)
    .all(since)
    .map((row) => ({
      ...auditEntry(row),
      time: readInteger(row, "decided_at"),
    }));
}

/** Local result decisions and evidence settle with the caller's host publication transaction. */
export function settleLocalItem(
  database: DatabaseSync,
  admission: FirewallLocalAdmission,
): void {
  const { deliveryToken } = admission.item;
  requireText(admission.evidence.conversation);
  requireBytes(admission.evidence.canonicalEntry);
  requireQueueFrontier(database, deliveryToken, admission.queuedItem);
  if (admission.deterministic !== undefined) {
    beginFirewallAttempt(database, admission.deterministic);
    completeFirewallAttempt(
      database,
      { ...admission.deterministic, admit: true },
      "incoming",
      admission.deterministic.canonicalCandidate,
    );
  }
  for (const completion of admission.completions) {
    completeFirewallAttempt(
      database,
      completion,
      "incoming",
      admission.queuedItem,
    );
  }
  markAnswers(database, admission.answers);
  database
    .prepare(`INSERT INTO firewall_local_evidence (conversation, anchor, canonical_entry)
 SELECT ?, anchor, ? FROM firewall_incoming WHERE delivery_token = ?`)
    .run(
      admission.evidence.conversation,
      admission.evidence.canonicalEntry,
      deliveryToken,
    );
  settleQueuedItem(database, deliveryToken, "admitted");
}

/** A started attempt survives interruption without being mistaken for a decision. */
export function beginFirewallAttempt(
  database: DatabaseSync,
  attempt: FirewallAttempt,
): void {
  requireText(attempt.checkId);
  requireBytes(attempt.canonicalCandidate);
  requireBytes(attempt.canonicalInput);
  database
    .prepare(`
    INSERT INTO firewall_checks (check_id, direction, canonical_candidate, canonical_input)
    VALUES (?, ?, ?, ?)
  `)
    .run(
      attempt.checkId,
      attempt.direction,
      attempt.canonicalCandidate,
      attempt.canonicalInput,
    );
}

/** A settled item cannot be offered for reassessment after restart. */
export function settleQueuedItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
  disposition: "admitted" | "withheld",
  checkId?: string,
): void {
  database
    .prepare(
      "UPDATE firewall_incoming SET disposition = ?, check_id = ? WHERE delivery_token = ?",
    )
    .run(disposition, checkId ?? null, deliveryToken);
}

/** A conversation commits its unsettled predecessor before later host items. */
export function requireQueueFrontier(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
  canonicalItem: Uint8Array,
): void {
  const queued = database
    .prepare(`
      SELECT conversation, sequence, canonical_item FROM firewall_incoming
      WHERE delivery_token = ? AND disposition = 'pending'
    `)
    .get(deliveryToken);
  if (queued === undefined) {
    throw new StoreSignal("conflict");
  }
  requireSameBytes(readBytes(queued, "canonical_item"), canonicalItem);
  const predecessor = database
    .prepare(`
      SELECT 1 AS pending FROM firewall_incoming
      WHERE conversation = ? AND sequence < ? AND disposition = 'pending' LIMIT 1
    `)
    .get(readText(queued, "conversation"), readInteger(queued, "sequence"));
  if (predecessor !== undefined) {
    throw new StoreSignal("conflict");
  }
}

/** Completes one retained check for exactly its captured candidate and direction. */
export function completeFirewallAttempt(
  database: DatabaseSync,
  completion: FirewallCompletion,
  direction: FirewallAttempt["direction"],
  canonicalCandidate: Uint8Array,
): FirewallCommit {
  checkingRow(database, completion, direction, canonicalCandidate);
  const disposition = completion.admit ? "admitted" : "withheld";
  completeFirewallCheck(database, completion, disposition);
  return disposition;
}

/** An expired queued request is retired once without deleting protocol context. */
export function retireQueuedItem(
  database: DatabaseSync,
  token: DeliveryToken,
): void {
  const retired = database
    .prepare(
      "UPDATE firewall_incoming SET disposition = 'withheld' WHERE delivery_token = ? AND disposition = 'pending'",
    )
    .run(token);
  if (retired.changes !== 1) {
    throw new StoreSignal("not-found");
  }
}

/**
 * Returns retained decisions without message content, private inputs,
 * diagnostics or rule text. Includes registered advice only for rules that
 * determined the decision.
 */
export function readDecisions(
  store: FirewallStore,
  request: { readonly since?: number },
  editableTextId: string,
) {
  return Effect.gen(function* () {
    const entries = yield* store.readFirewallDecisions(request.since);
    const rows = yield* Effect.forEach(
      entries,
      (entry) => decisionRows(entry, editableTextId),
      {
        concurrency: 1,
      },
    );
    return yield* Schema.decodeUnknown(firewallDecisionsSchema)({
      decisions: rows.flat(),
      activations: (yield* store.readFirewallActivations(request)).map(
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

function markAnswers(
  database: DatabaseSync,
  answers: FirewallLocalAdmission["answers"],
): void {
  for (const answer of answers) {
    requireText(answer.recordHash);
    const marked = database
      .prepare(`
        INSERT INTO firewall_answers (conversation_id, record_hash, admitted)
        SELECT conversation_id, record_hash, ? FROM certified_records WHERE record_hash = ?
        ON CONFLICT (conversation_id, record_hash) DO UPDATE SET admitted = excluded.admitted
      `)
      .run(answer.admitted ? 1 : 0, answer.recordHash);
    if (marked.changes !== 1) {
      throw new StoreSignal("conflict");
    }
  }
}

/** The started check a completion finishes, for exactly this candidate. */
function checkingRow(
  database: DatabaseSync,
  completion: FirewallCompletion,
  direction: FirewallAttempt["direction"],
  canonicalCandidate: Uint8Array,
): void {
  const row = database
    .prepare(
      "SELECT direction, canonical_candidate, disposition FROM firewall_checks WHERE check_id = ?",
    )
    .get(completion.checkId);
  if (
    row === undefined ||
    readText(row, "disposition") !== "checking" ||
    readText(row, "direction") !== direction
  ) {
    throw new StoreSignal("conflict");
  }
  requireSameBytes(readBytes(row, "canonical_candidate"), canonicalCandidate);
}

function auditEntry(
  row: Readonly<Record<string, unknown>>,
): FirewallAuditEntry {
  const canonicalResult = readOptionalBytes(row, "canonical_result");
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
    ...(canonicalResult === undefined ? {} : { canonicalResult }),
  };
}

function completeFirewallCheck(
  database: DatabaseSync,
  completion: Pick<FirewallCompletion, "checkId" | "canonicalResult">,
  disposition: FirewallCommit,
): void {
  requireBytes(completion.canonicalResult);
  const changed = database
    .prepare(`
    UPDATE firewall_checks SET canonical_result = ?, disposition = ?,
      decided_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE check_id = ? AND disposition = 'checking'
  `)
    .run(completion.canonicalResult, disposition, completion.checkId);
  if (changed.changes !== 1) {
    throw new StoreSignal("conflict");
  }
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
    const result =
      entry.canonicalResult === undefined
        ? null
        : withoutTraces(
            yield* decodeRuntimeValue(
              firewallCheckSchema,
              entry.canonicalResult,
            ),
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
  entry: FirewallAuditEntry & { readonly time: number },
  editableTextId: string,
) {
  return decodeFirewallAuditEntry(entry).pipe(
    Effect.flatMap((check) =>
      ruleOrigin(
        check.input.installation[check.direction],
        editableTextId,
      ).pipe(
        Effect.flatMap((origin) => projectDecision(check, entry.time, origin)),
      ),
    ),
  );
}

type DecodedCheck = Effect.Effect.Success<
  ReturnType<typeof decodeFirewallAuditEntry>
>;
type DecodedResult = NonNullable<DecodedCheck["result"]>;

type DecisionRow = (typeof firewallDecisionsSchema.Type.decisions)[number];
type Registration = DecodedCheck["input"]["installation"]["incoming"][number];

const textProvenance = Schema.parseJson(
  Schema.Struct({
    fixedRuleIds: Schema.Array(Schema.String),
    runtimeRuleIds: Schema.Array(Schema.String),
  }),
);

type RuleOrigin = (
  rule: DecidingRule,
) => Pick<DecisionRow["decidedBy"][number], "from" | "owner">;

function projectDecision(
  check: DecodedCheck,
  time: number,
  origin: RuleOrigin,
) {
  const result = check.result;
  if (
    result === null ||
    check.disposition === "checking" ||
    check.disposition === "interrupted"
  ) {
    return Effect.succeed([]);
  }
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

/**
 * Uses the installation retained with the check so later edits cannot change
 * rule ownership in earlier decisions.
 */
function ruleOrigin(
  registrations: readonly Registration[],
  editableTextId: string,
) {
  return Effect.gen(function* () {
    const text = registrations.find(
      (entry) =>
        entry.id === editableTextId &&
        entry.provenance.format === textPolicyFormat,
    );
    const recorded =
      text === undefined
        ? { fixedRuleIds: [], runtimeRuleIds: [] }
        : yield* Schema.decodeUnknown(textProvenance)(text.provenance.data);
    const fixed = new Set(recorded.fixedRuleIds);
    const runtime = new Set(recorded.runtimeRuleIds);
    return (rule: DecidingRule): ReturnType<RuleOrigin> => {
      if (rule.middlewareId !== text?.id) {
        return { from: "code" };
      }
      return fixed.has(rule.ruleId)
        ? { from: "fixed", owner: "owner" }
        : {
            from: "editable",
            owner: runtime.has(rule.ruleId) ? "runtime" : "owner",
          };
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
