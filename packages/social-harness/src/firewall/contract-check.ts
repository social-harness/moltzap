/** @file Joins firewall assessments to supplied history before evaluating a configured contract. */

import { Clock, Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import type { Message, Outgoing } from "../communication/service.js";
import type { FirewallEvidence } from "./chain.js";
import type { FirewallStore } from "./store.js";
import { canonicalBytes, decodeCanonical } from "../encoding/canonical-json.js";
import {
  type AdmittedAct,
  type CompiledContract,
  ContractProblem,
  type ProtocolRecord,
  protocolRecordSchema,
} from "./contract.js";
import {
  checkProtocol,
  projectProtocol,
  protocolGuidance,
  type ProtocolView,
} from "./protocol.js";
import { checkStructure, formatAct, readAct } from "./structure.js";

/** A failed check still retains the state and configuration needed to explain recovery. */
export type ContractCheck = {
  readonly view: ProtocolView;
  readonly contracts: readonly CompiledContract[];
  readonly selected?: CompiledContract;
  readonly guidance: ReturnType<typeof protocolGuidance>;
} & (
  | { readonly kind: "unconfigured" }
  | {
      readonly kind: "ready";
      readonly contract: CompiledContract;
      readonly record: ProtocolRecord;
    }
  | { readonly kind: "refused"; readonly problem: ContractProblem }
);

/** Application identity is shared with history; no delivery or queue metadata enters this key. */
export function assessmentKey(value: Outgoing): string {
  return `${value.author.agentId}/${"kind" in value ? value.operationId : value.msgId}`;
}

/** The firewall reads its own admission records; the caller supplies opaque public conversation messages. */
export function prepareContract(
  contracts: readonly CompiledContract[],
  store: FirewallStore,
  value: Outgoing,
  evidence: FirewallEvidence,
): Effect.Effect<ContractCheck> {
  return Effect.gen(function* () {
    let view: ProtocolView = {};
    let selected: CompiledContract | undefined;
    const evaluated = yield* Effect.gen(function* () {
      const history =
        evidence.protocolHistory?.messages ??
        evidence.history.map((entry) => entry.message);
      if (
        evidence.protocolHistory?.complete === false ||
        (evidence.protocolHistory === undefined &&
          (evidence.earlierHistoryOmitted || evidence.gaps.length !== 0))
      ) {
        return yield* missing("The preceding protocol history is incomplete.");
      }
      const admitted = yield* admittedHistory(store, history);
      view = {
        ...(yield* projectProtocol(admitted)),
        references: [
          ...history.map((message) => message.msgId),
          ...(evidence.references ?? []).map((reference) => reference.msgId),
        ],
      };
      if (view.active === undefined && contracts.length === 0) {
        return { kind: "unconfigured" as const };
      }
      const act = yield* readAct(value);
      const contract =
        view.active?.contract ??
        contracts.find((item) => item.name === act.norm);
      if (contract === undefined) {
        return yield* new ContractProblem({
          stage: "structural",
          reason: "rule-violation",
          detail: "ontology must name an installed norm.",
          field: "ontology",
        });
      }
      selected = contract;
      const form = yield* checkStructure(contract, act);
      const record = yield* checkProtocol(view, contract, form, {
        act,
        author: value.author.agentId,
        now: yield* Clock.currentTimeMillis,
      });
      return { kind: "ready" as const, contract, record };
    }).pipe(
      Effect.catchAll((problem) =>
        Effect.succeed({ kind: "refused" as const, problem }),
      ),
    );
    return {
      ...evaluated,
      view,
      contracts,
      ...(selected === undefined ? {} : { selected }),
      guidance: protocolGuidance(view, contracts, value.author.agentId),
    };
  }).pipe(Effect.withSpan("prepareContract"));
}

/** Feedback is an ordinary act only when the norm explicitly declares its representation. */
export function contractReply(
  check: ContractCheck,
  value: Outgoing,
  detail: string,
): string | undefined {
  const contract =
    check.kind === "ready" ? check.contract : check.view.active?.contract;
  const act = contract?.onRefusal;
  if (contract === undefined || act === undefined || "kind" in value) {
    return undefined;
  }
  const form = contract.forms.find((item) => item.act === act);
  if (form === undefined || !Object.hasOwn(form.fields.properties, "reason")) {
    return undefined;
  }
  return formatAct({
    name: act,
    norm: contract.name,
    inReplyTo: value.msgId,
    fields: { reason: detail },
  });
}

function admittedHistory(store: FirewallStore, history: readonly Message[]) {
  return Effect.gen(function* () {
    const rows = yield* store
      .readAssessments(history.map((message) => assessmentKey(message)))
      .pipe(
        Effect.mapError(() =>
          missing("The saved firewall assessments could not be read."),
        ),
      );
    const assessments = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.messageKey}/${createHash("sha256").update(row.candidate).digest("hex")}`;
      const previous = assessments.get(key);
      if (
        previous === undefined ||
        (previous.disposition === "withheld" && row.disposition === "admitted")
      ) {
        assessments.set(key, row);
      }
    }
    const admitted: AdmittedAct[] = [];
    for (const message of history) {
      const encoded = yield* canonicalBytes(message).pipe(
        Effect.mapError(() => missing("A retained message cannot be encoded.")),
      );
      const key = `${assessmentKey(message)}/${createHash("sha256").update(encoded).digest("hex")}`;
      const saved = assessments.get(key);
      if (saved === undefined) {
        return yield* missing(
          "An earlier conversation message has no retained local admission assessment.",
        );
      }
      if (saved.disposition === "admitted") {
        const result = yield* decodeCanonical(
          Schema.Record({ key: Schema.String, value: Schema.Unknown }),
          saved.result,
        ).pipe(
          Effect.mapError(() =>
            missing("An earlier assessment cannot be decoded."),
          ),
        );
        const protocol =
          result.protocol === undefined
            ? undefined
            : yield* Schema.decodeUnknown(protocolRecordSchema)(
                result.protocol,
              ).pipe(
                Effect.mapError(() =>
                  missing("An earlier contract assessment cannot be decoded."),
                ),
              );
        admitted.push({
          message,
          at: saved.at,
          ...(protocol === undefined ? {} : { protocol }),
        });
      } else {
        admitted.push({ message, at: saved.at });
      }
    }
    return admitted;
  });
}

function missing(detail: string) {
  return new ContractProblem({
    stage: "protocol",
    reason: "unresolved-evidence",
    detail,
  });
}
