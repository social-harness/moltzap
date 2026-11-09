/** @file Immutable configuration for structural, conversation and semantic checks. */

import { Data, Schema } from "effect";
import { type Message, RequestedSchema } from "../communication/service.js";
import { exactStruct } from "../encoding/canonical-json.js";
import { TextRule } from "./rules.js";

const name = Schema.String.pipe(
  Schema.pattern(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/u),
);
const names = Schema.Array(name);
const valueSchema = Schema.Union(
  Schema.String,
  Schema.Number.pipe(Schema.finite()),
  Schema.Boolean,
  Schema.Array(Schema.String),
);
const actSchema = exactStruct({
  name,
  norm: name,
  inReplyTo: Schema.optional(Schema.String),
  fields: Schema.Record({ key: name, value: valueSchema }),
});

/** Decoded fields retain their types; envelope metadata is not a free-form content channel. */
export type StructuredAct = typeof actSchema.Type;

const fieldSource = exactStruct({
  kind: Schema.Literal("field"),
  act: name,
  field: name,
});
const sourceSchema = Schema.Union(
  fieldSource,
  exactStruct({ kind: Schema.Literal("present"), act: name, fields: names }),
  exactStruct({ kind: Schema.Literal("values"), act: name, keys: fieldSource }),
);
const relationSchema = exactStruct({
  operator: Schema.Literal("equals", "member", "subset"),
  field: name,
  source: sourceSchema,
});
const formSchema = exactStruct({
  act: name,
  by: names,
  fields: RequestedSchema,
  starts: Schema.Boolean,
  ends: Schema.Boolean,
  when: names,
  unless: names,
  initiates: names,
  terminates: names,
  maximum: Schema.optional(Schema.Positive.pipe(Schema.int())),
  replyTo: Schema.optional(name),
  delay: Schema.optional(
    exactStruct({
      fact: name,
      field: name,
      millisecondsPerUnit: Schema.Positive,
    }),
  ),
  relations: Schema.Array(relationSchema),
});

/** The same form supplies field errors, permitted-action descriptions and transition semantics. */
export type MessageForm = typeof formSchema.Type;

/** All routing metadata is declarative; selecting an English rule does not judge its content. */
export const compiledContractSchema = exactStruct({
  name,
  digest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  source: Schema.String,
  description: Schema.String,
  roles: exactStruct({ initiator: name, participant: name }),
  forms: Schema.Array(formSchema),
  semanticRules: Schema.Array(
    exactStruct({ ...TextRule.fields, act: Schema.optional(name) }),
  ),
  onRefusal: Schema.optional(name),
});

/** Installed documents configure the firewall without executing code or owning resources. */
export type CompiledContract = typeof compiledContractSchema.Type;

/** An opening assessment retains the immutable document needed to replay that interaction. */
export const protocolRecordSchema = exactStruct({
  act: actSchema,
  digest: compiledContractSchema.fields.digest,
  opening: Schema.optional(compiledContractSchema),
});

/** Saved semantic admission authorizes replay of the exact structured act once. */
export type ProtocolRecord = typeof protocolRecordSchema.Type;

/** Conversation history and firewall admission have separate owners. */
export interface AdmittedAct {
  readonly message: Message;
  readonly at: number;
  readonly protocol?: ProtocolRecord;
}

/** A failure describes a check of the current candidate, never a delivery outcome. */
export class ContractProblem extends Data.TaggedError("ContractProblem")<{
  readonly stage: "structural" | "protocol";
  readonly reason: "rule-violation" | "unresolved-evidence";
  readonly detail: string;
  readonly field?: string;
}> {}
