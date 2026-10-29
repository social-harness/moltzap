/** @file Personal firewall composition for code and English policies. */

import { Effect } from "effect";
import { makeChain } from "./chain.js";
import {
  CheckInputError,
  decodeFrozen,
  type Firewall,
  FirewallSettings,
  type Message,
  type MessageContext,
  type MessageMiddleware,
} from "./contract/index.js";

// safer-arch-ignore no-inventory-barrel: The checking contract preserves code and English factories, decision projection and validated values as one evaluator boundary for policy and admission.

/** English rules and code policies share the same checking contract. */
export { englishPolicyFormat, makeEnglishPolicy } from "./english.js";
/** Client-synthesized holds use the same permitted advice as policy decisions. */
export {
  type DecidingRule,
  decidingRules,
  projectFeedback,
} from "./decision.js";
/** Credentials are supplied by trusted composition without environment lookup. */
export { makeJevDecisionProvider } from "./jev.js";
/** Closed failures never contain arbitrary agent-visible diagnostics. */
export {
  CheckInputError,
  DecisionProviderError,
  decodeFrozen,
  EnglishPolicySettings,
  EnglishRule,
  firewallCheckSchema,
  FirewallSettings,
  HistoryEntry,
  Message,
  MessageContext,
  MiddlewareError,
  PrivateCheckTrace,
  RuleDescription,
} from "./contract/index.js";
/** Policy authors exchange validated data; only guidance and feedback are runtime projections. */
export type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  Firewall,
  FirewallCheck,
  MessageMiddleware,
  MiddlewareInput,
  MiddlewareResult,
} from "./contract/index.js";

/**
 * Runs every installed check in order within the budget. Refusals accumulate;
 * only Client can apply the result to an exact candidate with fresh evidence.
 * Cancellation propagates, so an interrupted check never returns permission.
 *
 * ```mermaid
 * flowchart TD
 *   I[Incoming message or outgoing draft] --> C[Capture immutable context]
 *   C --> M[Run each registered middleware]
 *   M --> V[Validate and retain each atomic result]
 *   V --> D[Compose all findings and permitted advice]
 *   D --> R[Return to Client for enforcement]
 * ```
 */
export const makeFirewall = Effect.fn("makeFirewall")(function* (options: {
  readonly incoming: readonly MessageMiddleware[];
  readonly outgoing: readonly MessageMiddleware[];
  readonly settings: unknown;
}): Effect.fn.Return<Firewall, CheckInputError> {
  const settings = yield* decodeFrozen(FirewallSettings, options.settings).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "settings" })),
    ),
  );
  const incoming = yield* makeChain(options.incoming, settings);
  const outgoing = yield* makeChain(options.outgoing, settings);
  return Object.freeze({
    checkIncoming: (message: Message, context: MessageContext) =>
      incoming({ direction: "incoming", message }, context).pipe(
        Effect.flatMap((result) =>
          result.judgment === "revise"
            ? Effect.fail(new CheckInputError({ reason: "message" }))
            : Effect.succeed({ ...result, judgment: result.judgment }),
        ),
      ),
    checkOutgoing: (message: Message, context: MessageContext) =>
      outgoing({ direction: "outgoing", message }, context),
  });
});

/** Owner management values grant no runtime messaging capability. */
export {
  editableDocumentSchema,
  firewallDecisionsRequestSchema,
  firewallDecisionsSchema,
  FirewallPolicyError,
  type FirewallPolicyOperations,
  MAXIMUM_EDITABLE_RULES,
  type PolicyProblem,
  policyReadSchema,
  policyUpdateResultSchema,
  policyUpdateSchema,
} from "./contract/index.js";
