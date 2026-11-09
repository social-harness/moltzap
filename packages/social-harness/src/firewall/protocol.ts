/** @file Projects locally admitted conversations and checks declared transitions. */

import { Effect, Either } from "effect";
import { compareAscii } from "../encoding/identifier.js";
import {
  type AdmittedAct,
  type CompiledContract,
  ContractProblem,
  type MessageForm,
  type ProtocolRecord,
  type StructuredAct,
} from "./contract.js";
import { checkStructure, describeForm } from "./structure.js";

interface Fact {
  readonly at: number;
  readonly act: StructuredAct;
}

/** The projection is local policy context, not shared delivery or agent execution state. */
export interface ProtocolView {
  readonly references?: readonly string[];
  readonly conflicts?: ReadonlyArray<{
    readonly message: string;
    readonly explanation: string;
  }>;
  readonly active?: {
    readonly contract: CompiledContract;
    readonly initiator: string;
    readonly participant: string;
    readonly facts: ReadonlyMap<string, Fact>;
    readonly counts: ReadonlyMap<string, number>;
    readonly acts: readonly AdmittedAct[];
  };
}

type Active = NonNullable<ProtocolView["active"]>;
interface Candidate {
  readonly act: StructuredAct;
  readonly author: string;
  readonly now: number;
}

/** Retained order resolves concurrent assessments using their original times, without new inference. */
export function projectProtocol(
  history: readonly AdmittedAct[],
): Effect.Effect<ProtocolView, ContractProblem> {
  return Effect.gen(function* () {
    let view: ProtocolView = {};
    const seen = new Set<string>();
    const contracts = new Map<string, CompiledContract>();
    for (const entry of history) {
      const key = `${entry.message.author.agentId}/${entry.message.msgId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      view = yield* replayRecord(view, contracts, entry);
      view = {
        ...view,
        references: [...(view.references ?? []), entry.message.msgId],
      };
    }
    return view;
  }).pipe(Effect.withSpan("projectProtocol"));
}

/** An allowed transition describes a candidate; it does not mutate the retained conversation. */
export function checkProtocol(
  view: ProtocolView,
  contract: CompiledContract,
  form: MessageForm,
  candidate: Candidate,
): Effect.Effect<ProtocolRecord, ContractProblem> {
  return Effect.gen(function* () {
    const { act, author, now } = candidate;
    yield* checkReference(view, form, act);
    const active = view.active;
    if (active === undefined) {
      yield* checkOpening(contract, form);
      return { act, digest: contract.digest, opening: contract };
    }
    if (active.contract.digest !== contract.digest || form.starts) {
      return yield* violation(
        "The active interaction must finish before a new one starts.",
      );
    }
    const role = roleOf(active, author);
    if (
      role === undefined ||
      !form.by.includes(role) ||
      !enabled(form, active)
    ) {
      return yield* violation(
        "The sender role or current conversation state does not permit this act.",
      );
    }
    if (form.delay !== undefined) {
      yield* checkDelay(active, form.delay, now);
    }
    yield* checkRelations(active, form, act);
    return { act, digest: contract.digest };
  }).pipe(Effect.withSpan("checkProtocol"));
}

/** Feedback names permitted forms without selecting a next speaker or triggering work. */
export function protocolGuidance(
  view: ProtocolView,
  contracts: readonly CompiledContract[],
  author: string,
) {
  const active = view.active;
  return {
    state:
      active === undefined
        ? "idle"
        : [...active.facts.keys()].sort(compareAscii),
    ...(view.conflicts?.length
      ? {
          conflictCount: view.conflicts.length,
          lastConflict: view.conflicts.at(-1),
        }
      : {}),
    ...(active === undefined
      ? {}
      : {
          norm: active.contract.name,
          revision: active.contract.digest,
          role: roleOf(active, author),
        }),
    permittedActs:
      active === undefined
        ? contracts.flatMap((contract) =>
            contract.forms
              .filter((form) => form.starts)
              .map((form) => ({ norm: contract.name, ...describeForm(form) })),
          )
        : active.contract.forms
            .filter(
              (form) =>
                !form.starts &&
                form.by.includes(roleOf(active, author) ?? "") &&
                enabled(form, active),
            )
            .map((form) => timedForm(active, form)),
  };
}

function replayRecord(
  view: ProtocolView,
  contracts: Map<string, CompiledContract>,
  entry: AdmittedAct,
): Effect.Effect<ProtocolView, ContractProblem> {
  return Effect.gen(function* () {
    const protocol = entry.protocol;
    if (protocol === undefined) {
      return view;
    }
    if (protocol.opening !== undefined) {
      contracts.set(protocol.opening.digest, protocol.opening);
    }
    const contract = contracts.get(protocol.digest);
    const form = contract?.forms.find((item) => item.act === protocol.act.name);
    if (
      contract === undefined ||
      form === undefined ||
      (form.starts && protocol.opening === undefined)
    ) {
      return yield* unavailable(
        "The retained interaction does not contain a consistent opening contract.",
      );
    }
    const checked = yield* checkStructure(contract, protocol.act).pipe(
      Effect.flatMap((shape) =>
        checkProtocol(view, contract, shape, {
          act: protocol.act,
          author: entry.message.author.agentId,
          now: entry.at,
        }),
      ),
      Effect.either,
    );
    return yield* Either.match(checked, {
      onLeft: (error) =>
        Effect.succeed({
          ...view,
          conflicts: [
            ...(view.conflicts ?? []),
            { message: entry.message.msgId, explanation: error.detail },
          ],
        }),
      onRight: () => advance(view, contract, form, entry),
    });
  });
}

function checkReference(
  view: ProtocolView,
  form: MessageForm,
  act: StructuredAct,
) {
  return Effect.gen(function* () {
    const active = view.active;
    const known =
      (view.references ?? []).includes(act.inReplyTo ?? "") ||
      (active?.acts ?? []).some(
        (entry) => entry.message.msgId === act.inReplyTo,
      );
    if (act.inReplyTo !== undefined && !known) {
      return yield* violation(
        "in-reply-to must identify a preceding message in this conversation.",
        "in-reply-to",
      );
    }
    if (form.replyTo !== undefined && active !== undefined) {
      const reference = latest(active, form.replyTo);
      if (reference === undefined) {
        return yield* unavailable("The required preceding act is missing.");
      }
      if (act.inReplyTo !== reference.message.msgId) {
        return yield* violation(
          "in-reply-to must identify the latest required act in this interaction.",
          "in-reply-to",
        );
      }
    }
  });
}

function checkOpening(contract: CompiledContract, form: MessageForm) {
  if (!form.starts || !form.by.includes(contract.roles.initiator)) {
    return Effect.fail(
      violation("No interaction is active. Use a declared opening act."),
    );
  }
  const needsHistory =
    form.when.length !== 0 ||
    form.delay !== undefined ||
    form.replyTo !== undefined ||
    form.relations.length !== 0;
  return needsHistory
    ? Effect.fail(
        violation("This opening act requires earlier interaction evidence."),
      )
    : Effect.void;
}

function checkDelay(
  active: Active,
  delay: NonNullable<MessageForm["delay"]>,
  now: number,
) {
  const permittedAt = permittedTime(active, delay);
  if (permittedAt === undefined) {
    return Effect.fail(
      unavailable("The declared delay has no retained numeric anchor."),
    );
  }
  return now < permittedAt
    ? Effect.fail(
        violation(
          `This act is permitted at or after ${permittedAt} Unix milliseconds. The host may schedule the next attempt.`,
        ),
      )
    : Effect.void;
}

function checkRelations(active: Active, form: MessageForm, act: StructuredAct) {
  return Effect.gen(function* () {
    for (const relation of form.relations) {
      const expected = yield* sourceValue(active, relation.source);
      const actual = act.fields[relation.field];
      if (
        actual === undefined ||
        !related(relation.operator, actual, expected)
      ) {
        return yield* violation(
          `The field does not satisfy its declared ${relation.operator} relation to preceding messages.`,
          relation.field,
        );
      }
    }
  });
}

function timedForm(active: Active, form: MessageForm) {
  const notBefore =
    form.delay === undefined ? undefined : permittedTime(active, form.delay);
  return {
    ...describeForm(form),
    ...(notBefore === undefined ? {} : { notBefore }),
  };
}

function advance(
  view: ProtocolView,
  contract: CompiledContract,
  form: MessageForm,
  entry: AdmittedAct,
): Effect.Effect<ProtocolView, ContractProblem> {
  const peer = entry.message.recipients[0];
  const act = entry.protocol?.act;
  if (
    peer === undefined ||
    act === undefined ||
    (!form.starts && view.active === undefined)
  ) {
    return Effect.fail(
      unavailable("The retained interaction has no opening participants."),
    );
  }
  if (form.ends) {
    return Effect.succeed({ ...view, active: undefined });
  }
  const prior: Active = view.active ?? {
    contract,
    initiator: entry.message.author.agentId,
    participant: peer.agentId,
    facts: new Map(),
    counts: new Map(),
    acts: [],
  };
  const facts = new Map(prior.facts);
  const counts = new Map(prior.counts);
  for (const fact of form.terminates) {
    facts.delete(fact);
  }
  for (const fact of form.initiates) {
    facts.set(fact, { at: entry.at, act });
  }
  counts.set(form.act, (counts.get(form.act) ?? 0) + 1);
  return Effect.succeed({
    ...view,
    active: { ...prior, facts, counts, acts: [...prior.acts, entry] },
  });
}

function roleOf(active: Active, author: string) {
  if (author === active.initiator) {
    return active.contract.roles.initiator;
  }
  return author === active.participant
    ? active.contract.roles.participant
    : undefined;
}

function enabled(form: MessageForm, active: Active) {
  const facts =
    form.when.every((fact) => active.facts.has(fact)) &&
    form.unless.every((fact) => !active.facts.has(fact));
  const count =
    form.maximum === undefined ||
    (active.counts.get(form.act) ?? 0) < form.maximum;
  return facts && count;
}

function latest(active: Active, act: string) {
  return [...active.acts]
    .reverse()
    .find((entry) => entry.protocol?.act.name === act);
}

function permittedTime(
  active: Active,
  delay: NonNullable<MessageForm["delay"]>,
) {
  const fact = active.facts.get(delay.fact);
  const duration = fact?.act.fields[delay.field];
  return fact !== undefined && typeof duration === "number"
    ? fact.at + duration * delay.millisecondsPerUnit
    : undefined;
}

function related(
  operator: MessageForm["relations"][number]["operator"],
  actual: StructuredAct["fields"][string],
  expected: StructuredAct["fields"][string],
) {
  switch (operator) {
    case "equals":
      return JSON.stringify(actual) === JSON.stringify(expected);
    case "member":
      return (
        Array.isArray(expected) && expected.some((item) => item === actual)
      );
    case "subset":
      return (
        Array.isArray(actual) &&
        Array.isArray(expected) &&
        actual.every((item) => expected.includes(item))
      );
    default: {
      const exhaustive: never = operator;
      return exhaustive;
    }
  }
}

function sourceValue(
  active: Active,
  source: MessageForm["relations"][number]["source"],
): Effect.Effect<StructuredAct["fields"][string], ContractProblem> {
  return Effect.gen(function* () {
    const fields = latest(active, source.act)?.protocol?.act.fields;
    if (fields === undefined) {
      return yield* unavailable(
        "A declared relation needs an earlier act that is missing.",
      );
    }
    if (source.kind === "field") {
      const value = fields[source.field];
      if (value === undefined) {
        return yield* unavailable(
          "A declared relation needs an earlier field that is missing.",
        );
      }
      return value;
    }
    if (source.kind === "present") {
      return source.fields.filter((field) => Object.hasOwn(fields, field));
    }
    const keys = yield* sourceValue(active, source.keys);
    if (
      typeof keys === "string" ||
      typeof keys === "number" ||
      typeof keys === "boolean"
    ) {
      return yield* unavailable(
        "A selected-values relation needs a list of field names.",
      );
    }
    return yield* Effect.forEach(
      keys,
      (key) => {
        const value = fields[key];
        return typeof value === "string"
          ? Effect.succeed(value)
          : Effect.fail(
              unavailable("A selected value is missing or is not a string."),
            );
      },
      { concurrency: 1 },
    );
  });
}

function violation(detail: string, field?: string) {
  return new ContractProblem({
    stage: "protocol",
    reason: "rule-violation",
    detail,
    ...(field === undefined ? {} : { field }),
  });
}

function unavailable(detail: string) {
  return new ContractProblem({
    stage: "protocol",
    reason: "unresolved-evidence",
    detail,
  });
}
