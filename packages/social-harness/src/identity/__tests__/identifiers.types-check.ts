/**
 * @file Identity strings remain distinct nominal values. This prevents a valid
 * identifier from silently crossing into another semantic position merely
 * because both values share the same encoded string representation.
 */

import type {
  AgentId,
  AgentName,
  EnvelopeId,
  PrincipalId,
} from "../../index.js";
import type { AgentCardDigest } from "../cards.js";
import type { OperationId } from "../registry/index.js";
import type { AgentCardIssuedAt } from "./agent-card-fixtures.js";

/**
 * True when a value of either type is assignable to the other, that is, when
 * one identifier can cross into the other's position.
 */
type Crosses<Left, Right> = [Left] extends [Right]
  ? true
  : [Right] extends [Left]
    ? true
    : false;
type Expect<Value extends true> = Value;
type ExpectFalse<Value extends false> = Value;

type IdentityValue =
  | AgentId
  | PrincipalId
  | AgentName
  | OperationId
  | EnvelopeId
  | AgentCardDigest
  | AgentCardIssuedAt;

type RawStringsCannotConstructValues = ExpectFalse<
  string extends IdentityValue ? true : false
>;

type AgentAndPrincipalDiffer = ExpectFalse<Crosses<AgentId, PrincipalId>>;
type AgentAndOperationDiffer = ExpectFalse<Crosses<AgentId, OperationId>>;
type AgentAndEnvelopeDiffer = ExpectFalse<Crosses<AgentId, EnvelopeId>>;
type AgentAndCardDigestDiffer = ExpectFalse<Crosses<AgentId, AgentCardDigest>>;
type AgentAndNameDiffer = ExpectFalse<Crosses<AgentId, AgentName>>;
type PrincipalAndNameDiffer = ExpectFalse<Crosses<PrincipalId, AgentName>>;
type PrincipalAndOperationDiffer = ExpectFalse<
  Crosses<PrincipalId, OperationId>
>;
type PrincipalAndEnvelopeDiffer = ExpectFalse<Crosses<PrincipalId, EnvelopeId>>;
type PrincipalAndCardDigestDiffer = ExpectFalse<
  Crosses<PrincipalId, AgentCardDigest>
>;
type NameAndOperationDiffer = ExpectFalse<Crosses<AgentName, OperationId>>;
type NameAndEnvelopeDiffer = ExpectFalse<Crosses<AgentName, EnvelopeId>>;
type NameAndCardDigestDiffer = ExpectFalse<Crosses<AgentName, AgentCardDigest>>;
type OperationAndEnvelopeDiffer = ExpectFalse<Crosses<OperationId, EnvelopeId>>;
type OperationAndCardDigestDiffer = ExpectFalse<
  Crosses<OperationId, AgentCardDigest>
>;
type EnvelopeAndCardDigestDiffer = ExpectFalse<
  Crosses<EnvelopeId, AgentCardDigest>
>;
type IssuedAtAndAgentDiffer = ExpectFalse<Crosses<AgentCardIssuedAt, AgentId>>;
type IssuedAtAndPrincipalDiffer = ExpectFalse<
  Crosses<AgentCardIssuedAt, PrincipalId>
>;
type IssuedAtAndNameDiffer = ExpectFalse<Crosses<AgentCardIssuedAt, AgentName>>;
type IssuedAtAndOperationDiffer = ExpectFalse<
  Crosses<AgentCardIssuedAt, OperationId>
>;
type IssuedAtAndEnvelopeDiffer = ExpectFalse<
  Crosses<AgentCardIssuedAt, EnvelopeId>
>;
type IssuedAtAndCardDigestDiffer = ExpectFalse<
  Crosses<AgentCardIssuedAt, AgentCardDigest>
>;
type RefinedValuesRemainStrings = Expect<
  IdentityValue extends string ? true : false
>;

/** Compile-time witnesses for the package's public identity-value invariants. */
export type IdentityValueCanaries = [
  RawStringsCannotConstructValues,
  AgentAndPrincipalDiffer,
  AgentAndOperationDiffer,
  AgentAndEnvelopeDiffer,
  AgentAndCardDigestDiffer,
  AgentAndNameDiffer,
  PrincipalAndNameDiffer,
  PrincipalAndOperationDiffer,
  PrincipalAndEnvelopeDiffer,
  PrincipalAndCardDigestDiffer,
  NameAndOperationDiffer,
  NameAndEnvelopeDiffer,
  NameAndCardDigestDiffer,
  OperationAndEnvelopeDiffer,
  OperationAndCardDigestDiffer,
  EnvelopeAndCardDigestDiffer,
  IssuedAtAndAgentDiffer,
  IssuedAtAndPrincipalDiffer,
  IssuedAtAndNameDiffer,
  IssuedAtAndOperationDiffer,
  IssuedAtAndEnvelopeDiffer,
  IssuedAtAndCardDigestDiffer,
  RefinedValuesRemainStrings,
];
