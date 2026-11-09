/** @file Resolves declared names and checks that protocol predicates have usable evidence. */

import { Effect } from "effect";
import type { CompiledContract, MessageForm } from "../firewall/contract.js";
import { NormDocumentError } from "./document.js";

/** Invalid references fail installation instead of becoming unreachable runtime forms. */
export function validateReferences(contract: CompiledContract) {
  return Effect.gen(function* () {
    const forms = new Map(contract.forms.map((form) => [form.act, form]));
    if (forms.size !== contract.forms.length) {
      return yield* new NormDocumentError({
        detail: "An act has exactly one declared form.",
      });
    }
    if (!contract.forms.some((form) => form.starts)) {
      return yield* new NormDocumentError({
        detail: "Declare at least one opening act with :starts true.",
      });
    }
    if (
      contract.semanticRules.some(
        (rule) => rule.act !== undefined && !forms.has(rule.act),
      )
    ) {
      return yield* new NormDocumentError({
        detail: "An English rule names an undeclared act.",
      });
    }
    for (const form of contract.forms) {
      yield* validateForm(contract, form, forms);
    }
    yield* validateRefusal(contract, forms);
  }).pipe(Effect.withSpan("validateReferences"));
}

function validateForm(
  contract: CompiledContract,
  form: MessageForm,
  forms: ReadonlyMap<string, MessageForm>,
) {
  return Effect.gen(function* () {
    const roles = Object.values(contract.roles);
    const facts = new Set(contract.forms.flatMap((item) => item.initiates));
    if (form.by.length === 0 || form.by.some((role) => !roles.includes(role))) {
      return yield* new NormDocumentError({
        detail: "Every sender role must be declared.",
        declaration: form.act,
      });
    }
    if (
      !/^[a-z][a-z0-9-]{0,63}$/u.test(form.act) ||
      [...form.when, ...form.unless, ...form.terminates].some(
        (fact) => !facts.has(fact),
      )
    ) {
      return yield* new NormDocumentError({
        detail: "Act names are lowercase; fact guards refer to declared facts.",
        declaration: form.act,
      });
    }
    if (form.starts) {
      yield* validateOpening(contract, form);
    }
    if (form.replyTo !== undefined && !forms.has(form.replyTo)) {
      return yield* new NormDocumentError({
        detail: "A reply reference names an undeclared act.",
        declaration: form.act,
      });
    }
    if (form.delay !== undefined) {
      yield* validateDelay(contract, form.delay);
    }
    for (const relation of form.relations) {
      yield* validateRelation(form, relation, forms);
    }
  });
}

function validateRefusal(
  contract: CompiledContract,
  forms: ReadonlyMap<string, MessageForm>,
) {
  if (contract.onRefusal === undefined) {
    return Effect.void;
  }
  const form = forms.get(contract.onRefusal);
  if (form === undefined) {
    return Effect.fail(
      new NormDocumentError({
        detail: "The refusal act must have a declared form.",
      }),
    );
  }
  return form.fields.properties.reason?.type !== "string" ||
    form.fields.required?.some((field) => field !== "reason")
    ? Effect.fail(
        new NormDocumentError({
          detail:
            "Automatic refusal supplies a reason string and no other required fields.",
        }),
      )
    : Effect.void;
}

function validateOpening(contract: CompiledContract, form: MessageForm) {
  const needsHistory =
    form.when.length !== 0 ||
    form.delay !== undefined ||
    form.replyTo !== undefined ||
    form.relations.length !== 0;
  return !form.by.includes(contract.roles.initiator) || needsHistory
    ? Effect.fail(
        new NormDocumentError({
          detail:
            "An opening act permits the initiator and cannot depend on an earlier interaction.",
          declaration: form.act,
        }),
      )
    : Effect.void;
}

function validateDelay(
  contract: CompiledContract,
  delay: NonNullable<MessageForm["delay"]>,
) {
  const anchors = contract.forms.filter((item) =>
    item.initiates.includes(delay.fact),
  );
  const valid =
    anchors.length !== 0 &&
    anchors.every((anchor) => {
      const field = anchor.fields.properties[delay.field];
      if (
        field === undefined ||
        (field.type !== "number" && field.type !== "integer")
      ) {
        return false;
      }
      return (
        anchor.fields.required?.includes(delay.field) &&
        field.minimum !== undefined &&
        field.minimum >= 0
      );
    });
  return valid
    ? Effect.void
    : Effect.fail(
        new NormDocumentError({
          detail:
            "A delay references a required nonnegative numeric field on every act that initiates its fact.",
        }),
      );
}

function validateRelation(
  form: MessageForm,
  relation: MessageForm["relations"][number],
  forms: ReadonlyMap<string, MessageForm>,
) {
  return Effect.gen(function* () {
    const source = relation.source;
    const target = forms.get(source.act);
    const candidate = form.fields.properties[relation.field];
    if (candidate === undefined || target === undefined) {
      return yield* new NormDocumentError({
        detail: "A relation refers to undeclared acts or fields.",
        declaration: form.act,
      });
    }
    if (relation.operator === "subset" && candidate.type !== "array") {
      return yield* new NormDocumentError({
        detail: "A subset relation requires a list field.",
        declaration: form.act,
      });
    }
    if (source.kind === "values") {
      yield* validateSelectedValues(source.keys, target, forms);
    } else {
      const fields = source.kind === "field" ? [source.field] : source.fields;
      if (
        fields.some((field) => !Object.hasOwn(target.fields.properties, field))
      ) {
        return yield* new NormDocumentError({
          detail: "A relation names an undeclared source field.",
          declaration: form.act,
        });
      }
    }
  });
}

function validateSelectedValues(
  keys: Extract<
    MessageForm["relations"][number]["source"],
    { readonly kind: "field" }
  >,
  target: MessageForm,
  forms: ReadonlyMap<string, MessageForm>,
) {
  const field = forms.get(keys.act)?.fields.properties[keys.field];
  if (field?.type !== "array" || !("enum" in field.items)) {
    return Effect.fail(
      new NormDocumentError({
        detail:
          "Selected values require a choice list of declared string field names.",
      }),
    );
  }
  return field.items.enum.some(
    (key) => target.fields.properties[key]?.type !== "string",
  )
    ? Effect.fail(
        new NormDocumentError({
          detail: "Selected values name an undeclared string field.",
        }),
      )
    : Effect.void;
}
