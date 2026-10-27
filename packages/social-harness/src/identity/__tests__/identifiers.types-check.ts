/**
 * @file Identity strings remain distinct nominal values. This prevents a valid
 * identifier from silently crossing into another semantic position merely
 * because both values share the same encoded string representation.
 */

import type {
  AgentId,
  AgentName,
  MessageId,
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
  | MessageId
  | AgentCardDigest
  | AgentCardIssuedAt;

type RawStringsCannotConstructValues = ExpectFalse<
  string extends IdentityValue ? true : false
>;

type AgentAndPrincipalDiffer = ExpectFalse<Crosses<AgentId, PrincipalId>>;
type AgentAndOperationDiffer = ExpectFalse<Crosses<AgentId, OperationId>>;
type AgentAndMessageDiffer = ExpectFalse<Crosses<AgentId, MessageId>>;
type AgentAndCardDigestDiffer = ExpectFalse<Crosses<AgentId, AgentCardDigest>>;
type AgentAndNameDiffer = ExpectFalse<Crosses<AgentId, AgentName>>;
type PrincipalAndNameDiffer = ExpectFalse<Crosses<PrincipalId, AgentName>>;
type PrincipalAndOperationDiffer = ExpectFalse<
  Crosses<PrincipalId, OperationId>
>;
type PrincipalAndMessageDiffer = ExpectFalse<Crosses<PrincipalId, MessageId>>;
type PrincipalAndCardDigestDiffer = ExpectFalse<
  Crosses<PrincipalId, AgentCardDigest>
>;
type NameAndOperationDiffer = ExpectFalse<Crosses<AgentName, OperationId>>;
type NameAndMessageDiffer = ExpectFalse<Crosses<AgentName, MessageId>>;
type NameAndCardDigestDiffer = ExpectFalse<Crosses<AgentName, AgentCardDigest>>;
type OperationAndMessageDiffer = ExpectFalse<Crosses<OperationId, MessageId>>;
type OperationAndCardDigestDiffer = ExpectFalse<
  Crosses<OperationId, AgentCardDigest>
>;
type MessageAndCardDigestDiffer = ExpectFalse<
  Crosses<MessageId, AgentCardDigest>
>;
type IssuedAtAndAgentDiffer = ExpectFalse<Crosses<AgentCardIssuedAt, AgentId>>;
type IssuedAtAndPrincipalDiffer = ExpectFalse<
  Crosses<AgentCardIssuedAt, PrincipalId>
>;
type IssuedAtAndNameDiffer = ExpectFalse<Crosses<AgentCardIssuedAt, AgentName>>;
type IssuedAtAndOperationDiffer = ExpectFalse<
  Crosses<AgentCardIssuedAt, OperationId>
>;
type IssuedAtAndMessageDiffer = ExpectFalse<
  Crosses<AgentCardIssuedAt, MessageId>
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
  AgentAndMessageDiffer,
  AgentAndCardDigestDiffer,
  AgentAndNameDiffer,
  PrincipalAndNameDiffer,
  PrincipalAndOperationDiffer,
  PrincipalAndMessageDiffer,
  PrincipalAndCardDigestDiffer,
  NameAndOperationDiffer,
  NameAndMessageDiffer,
  NameAndCardDigestDiffer,
  OperationAndMessageDiffer,
  OperationAndCardDigestDiffer,
  MessageAndCardDigestDiffer,
  IssuedAtAndAgentDiffer,
  IssuedAtAndPrincipalDiffer,
  IssuedAtAndNameDiffer,
  IssuedAtAndOperationDiffer,
  IssuedAtAndMessageDiffer,
  IssuedAtAndCardDigestDiffer,
  RefinedValuesRemainStrings,
];
