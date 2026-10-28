/**
 * @file The collective norm bundle: code rules on how an agent opens and
 * posts to collectives, and English norms on gathering, announcing and
 * settling, one registration per direction.
 */

import { Effect } from "effect";
import { packageVersion } from "../../release/index.js";
import {
  type CheckInputError,
  type DecisionProvider,
  type EnglishPolicySettings,
  type EnglishRule,
  makeEnglishPolicy,
  type Message,
  type MessageContext,
  type MessageMiddleware,
  type MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
} from "../evaluator/index.js";
import { noAcknowledgementPosts } from "./acknowledgements.js";
import { oneOpenRequest } from "./open-requests.js";
import { type CodeRule, revisionOutcome, sha256 } from "./outcome.js";

/**
 * The bundle's registration id in both directions. It names the bundle
 * across every text change, which moves only its revision, so an audit
 * reader finds it in every agent's checks.
 */
const COLLECTIVE_NORMS_ID = "org.social-harness/collective-norms";

/**
 * The shipped behaviors in `behaviors/collectives/` the bundle's English norms
 * are read from, each under its behavior name; the text has no other copy.
 * These are assessed on what the agent sends and on what it receives.
 */
const OUTGOING_BEHAVIORS: readonly string[] = [
  "collectives/one-gather",
  "collectives/announce-once",
  "collectives/result-settles",
];

/**
 * The norms assessed on what the agent receives: the outgoing ones and the
 * acknowledgement norm, which selects response expectations; `none` is not a
 * refusal.
 */
const INCOMING_BEHAVIORS: readonly string[] = [
  "collectives/empty-acknowledgement",
  ...OUTGOING_BEHAVIORS,
];

/**
 * A code rule of the bundle, whose assessment may also read the agent's
 * facilitator role.
 */
interface BundleRule extends Omit<CodeRule, "assess"> {
  readonly assess: (
    message: Message,
    situation: {
      readonly context: MessageContext;
      readonly facilitator: boolean;
    },
  ) => "pass" | "not-applicable" | "revise";
}

/** A rule the built-ins also register, which reads no facilitator role. */
function shared(rule: CodeRule): BundleRule {
  return {
    ...rule,
    assess: (message, { context }) => rule.assess(message, context),
  };
}

/**
 * The bundle's code rules, which assess only what the agent sends. The
 * built-ins register `one-open-request` and `no-acknowledgement-posts` from
 * the same definitions.
 */
const CODE_RULES: readonly BundleRule[] = [
  {
    description: {
      id: "facilitator-starts-collectives",
      kind: "norm",
      feedback: {
        text: "Only the run's facilitator starts a gather or all_gather that asks several members. Send your question or proposal to the facilitator instead, or ask one member what only that member can answer.",
        nextAction: "revise",
      },
    },
    statement:
      "Only an agent configured as the run's facilitator starts a gather or all_gather that asks two or more members.",
    assess: (message, { facilitator }) =>
      message.operation?.kind === "request" && message.recipients.length > 1
        ? revisionOutcome(!facilitator)
        : "not-applicable",
  },
  shared(oneOpenRequest),
  shared(noAcknowledgementPosts),
];

/** The bundle's registration for each direction. */
export interface CollectiveNorms {
  readonly incoming: MessageMiddleware;
  readonly outgoing: (facilitator: boolean) => MessageMiddleware;
}

/**
 * The bundle under its id and one revision. The incoming registration
 * assesses the incoming English rules; the outgoing one runs the code rules
 * first and asks the English assessor only when no code rule refused the
 * send, so a deterministic refusal costs no decision provider call and keeps
 * its own feedback whatever the provider's state. The revision is the SHA-256
 * of the edition, both English middlewares' revisions, which hash the English
 * settings and question semantics, the history window the checks read, and
 * the decision provider's provenance.
 * It excludes `facilitator`, which only the outgoing registration's
 * provenance records, so every member of a run registers the same revision.
 * @param provider The service that assesses the English rules.
 * @param settings The English assessment bounds.
 * @param readBehavior Reads a shipped behavior by its pack and name. Policy
 *     composition passes it in, because this folder reads no files.
 * @param historyRecords The history window each check reads, if the policy
 *     sets one.
 * @returns The incoming registration and the outgoing one for a role.
 */
export const collectiveNorms = Effect.fn("collectiveNorms")(function* (
  provider: DecisionProvider,
  settings: EnglishPolicySettings,
  readBehavior: (name: string) => Effect.Effect<EnglishRule>,
  historyRecords?: number,
): Effect.fn.Return<CollectiveNorms, CheckInputError> {
  const incomingRules = yield* Effect.forEach(
    INCOMING_BEHAVIORS,
    readBehavior,
    {
      concurrency: 1,
    },
  );
  const outgoingRules = incomingRules.slice(1);
  const edition = editionOf(incomingRules, outgoingRules);
  const incoming = yield* makeEnglishPolicy({
    id: COLLECTIVE_NORMS_ID,
    rules: incomingRules,
    settings,
    provider,
  });
  const outgoing = yield* makeEnglishPolicy({
    id: COLLECTIVE_NORMS_ID,
    rules: outgoingRules,
    settings,
    provider,
  });
  const revision = sha256(
    JSON.stringify({
      edition,
      english: { incoming: incoming.revision, outgoing: outgoing.revision },
      historyRecords: historyRecords ?? null,
      provider: provider.provenance ?? null,
    }),
  );
  return {
    incoming: {
      ...registration(incoming, revision, edition, {}),
      check: (input) => incoming.check(input),
    },
    outgoing: (facilitator) => ({
      ...registration(outgoing, revision, edition, { facilitator }),
      rules: [...CODE_RULES.map((rule) => rule.description), ...outgoing.rules],
      check: (input) => checkOutgoing(input, outgoing, facilitator),
    }),
  };
});

/**
 * Every rule of the bundle in each direction, with its full text or code
 * rule statement, and the Client release, which can change how the decision
 * provider's answers compose without changing the question edition. The
 * facilitator role is an input to the code rules' assessment, not part of
 * the edition. A change to how a code rule assesses that these fields do not
 * show bumps `edition`.
 * @param incoming The English rules assessed on what the agent receives.
 * @param outgoing The English rules assessed on what the agent sends.
 * @returns The edition the revision and provenance record.
 */
function editionOf(
  incoming: readonly EnglishRule[],
  outgoing: readonly EnglishRule[],
) {
  return {
    edition: "org.social-harness/collective-norms/v1",
    client: packageVersion,
    incoming,
    outgoing: [
      ...CODE_RULES.map(({ description, statement }) => ({
        id: description.id,
        kind: description.kind,
        feedback: description.feedback,
        statement,
      })),
      ...outgoing,
    ],
  };
}

type Edition = ReturnType<typeof editionOf>;

/** A send's code findings, then the English findings unless a code rule refused it. */
function checkOutgoing(
  input: MiddlewareInput,
  english: MessageMiddleware,
  facilitator: boolean,
): Effect.Effect<MiddlewareResult, MiddlewareError> {
  const code = CODE_RULES.map((rule) => ({
    ruleId: rule.description.id,
    outcome: rule.assess(input.event.message, {
      context: input.context,
      facilitator,
    }),
  }));
  if (code.some((finding) => finding.outcome === "revise")) {
    return Effect.succeed({
      findings: [
        ...code,
        ...english.rules.map((rule) => ({
          ruleId: rule.id,
          outcome: "not-applicable" as const,
        })),
      ],
      expectations: [],
    });
  }
  return english.check(input).pipe(
    Effect.map(
      (result): MiddlewareResult => ({
        findings: [...code, ...result.findings],
        expectations: result.expectations,
        ...(result.trace === undefined ? {} : { trace: result.trace }),
      }),
    ),
  );
}

/**
 * The fields both directions' registrations share: the bundle's id and
 * revision, the English rules, and provenance holding the edition, the
 * role, if any, and the English middleware's own provenance.
 */
function registration(
  english: MessageMiddleware,
  revision: string,
  edition: Edition,
  role: Readonly<Record<string, boolean>>,
): Omit<MessageMiddleware, "check"> {
  return {
    id: COLLECTIVE_NORMS_ID,
    revision,
    rules: english.rules,
    provenance: {
      format: "org.social-harness/collective-norms.v1",
      data: JSON.stringify({
        edition,
        ...role,
        english: english.provenance ?? null,
      }),
    },
  };
}
