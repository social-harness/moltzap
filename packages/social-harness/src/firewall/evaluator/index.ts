/** @file Personal firewall composition for code and natural-language policies. */

import { Effect } from "effect";
import { makeCapturedChain, makeChain } from "./chain.js";
import {
  CheckInputError,
  decodeFrozen,
  type Firewall,
  FirewallSettings,
  type Message,
  type MessageContext,
  type MessageMiddleware,
} from "./contract/index.js";

// safer-arch-ignore no-inventory-barrel: The checking contract preserves code and natural-language factories, decision projection and validated values as one evaluator boundary for policy and admission.

/** Natural-language rules and code policies share the same checking contract. */
export { makeTextPolicy, textPolicyFormat } from "./text-policy.js";
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
  firewallCheckSchema,
  FirewallSettings,
  HistoryEntry,
  Message,
  MessageContext,
  MiddlewareError,
  PrivateCheckTrace,
  RuleDescription,
  TextPolicySettings,
  TextRule,
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
 * the host applies the result to the exact assessed candidate.
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
      incoming({ direction: "incoming", message }, context),
    checkOutgoing: (message: Message, context: MessageContext) =>
      outgoing({ direction: "outgoing", message }, context),
  });
});

/** Installation reuses already detached registrations while public construction validates its inputs. */
export const makeCapturedFirewall = Effect.fn("makeCapturedFirewall")(
  function* (options: {
    readonly incoming: readonly MessageMiddleware[];
    readonly outgoing: readonly MessageMiddleware[];
    readonly settings: FirewallSettings;
  }): Effect.fn.Return<Firewall, CheckInputError> {
    const incoming = yield* makeCapturedChain(
      options.incoming,
      options.settings,
    );
    const outgoing = yield* makeCapturedChain(
      options.outgoing,
      options.settings,
    );
    return Object.freeze({
      checkIncoming: (message: Message, context: MessageContext) =>
        incoming({ direction: "incoming", message }, context),
      checkOutgoing: (message: Message, context: MessageContext) =>
        outgoing({ direction: "outgoing", message }, context),
    });
  },
);

/** Fixed code registration is shared by installation and public construction. */
export { captureRegistration } from "./chain.js";
