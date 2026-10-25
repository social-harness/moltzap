/** @file Representation-neutral decisions and registered runtime advice. */

import type {
  FirewallCheck,
  MessageContext,
  MessageEvent,
  MessageMiddleware,
  MiddlewareCheck,
  MiddlewareObservation,
  NormExpectation,
  NormGuidance,
  PolicyFinding,
  RuleDescription,
  UncertainNormGuidance,
} from "./contract/index.js";

type Reason = FirewallCheck["reason"];

const judgments: Readonly<Record<Reason, FirewallCheck["judgment"]>> = {
  eligible: "allow",
  prohibited: "block",
  "unresolved-evidence": "hold",
  "check-unavailable": "hold",
  "norm-violation": "revise",
  "approval-required": "hold",
};

const defaultFeedback: Readonly<Record<Reason, FirewallCheck["feedback"]>> = {
  eligible: [],
  prohibited: [
    {
      nextAction: "stop",
      text: "This message is prohibited by the owner's policy.",
    },
  ],
  "unresolved-evidence": [
    {
      nextAction: "wait",
      text: "Required policy evidence is missing or uncertain. The message is held for owner review.",
    },
  ],
  "check-unavailable": [
    {
      nextAction: "wait",
      text: "A required policy check is unavailable. The message is held for owner review.",
    },
  ],
  "norm-violation": [
    {
      nextAction: "revise",
      text: "Revise the message to satisfy the owner's communication norms before making a new send attempt.",
    },
  ],
  "approval-required": [
    {
      nextAction: "seek-approval",
      text: "Owner approval is required for this exact message. The message has not been admitted.",
    },
  ],
};

/**
 * A pass cannot erase another policy's findings. Approval satisfies only its
 * own requirement; prohibition, unavailable evidence and norm repair take priority.
 */
export function composeDecision(
  event: MessageEvent,
  context: MessageContext,
  middleware: readonly MessageMiddleware[],
  checks: readonly MiddlewareCheck[],
): FirewallCheck {
  const reason = selectReason(event, context, checks);
  return {
    judgment: judgments[reason],
    reason,
    feedback: projectFeedback(middleware, checks, reason),
    guidance: reason === "eligible" ? projectGuidance(middleware, checks) : [],
    checks,
  };
}

/** Missing applicable advice receives the safe default for the final reason. */
export function projectFeedback(
  middleware: readonly MessageMiddleware[],
  checks: readonly MiddlewareCheck[],
  reason: Reason,
): FirewallCheck["feedback"] {
  const feedback = middleware.flatMap((entry) => {
    const selected =
      checks
        .find((check) => check.middlewareId === entry.id)
        ?.findings.filter((finding) => matchesReason(finding, reason))
        .map((finding) => finding.ruleId) ?? [];
    return entry.rules.flatMap((rule) =>
      selected.includes(rule.id) &&
      rule.feedback !== undefined &&
      validNextAction(reason, rule.feedback.nextAction)
        ? [{ ...rule.feedback }]
        : [],
    );
  });
  return feedback.length === 0
    ? defaultFeedback[reason].map((entry) => ({ ...entry }))
    : feedback;
}

/**
 * A rule that produced a decision's reason. `finding` is `unavailable` when
 * its check could not run or its judgment could not be obtained, `uncertain`
 * when the judgment was left unsettled, and `settled` otherwise. `advice` is
 * the rule's own registered text the decision projects for it: its guidance
 * for an admission, or its feedback when the reason permits its next action.
 */
export interface DecidingRule {
  readonly middlewareId: string;
  readonly ruleId: string;
  readonly finding: "settled" | "uncertain" | "unavailable";
  readonly advice?: string;
}

interface Registration {
  readonly id: string;
  readonly rules: readonly RuleDescription[];
}
type Observation = Pick<
  MiddlewareObservation,
  "middlewareId" | "status" | "findings" | "expectations"
>;

/**
 * The rules that produced `reason`, once each in chain order. An admission
 * is decided by the norms assessed as uncertain, which admit with guidance, and
 * by no rule otherwise. An unavailable check is decided by every rule it
 * registers; a hold on unresolved evidence by its holding rules and any
 * conflicting expectations. Every other reason is decided by the findings
 * that select it. A hold on missing context evidence alone has no rule.
 */
export function decidingRules(
  reason: Reason,
  middleware: readonly Registration[],
  checks: readonly Observation[],
): readonly DecidingRule[] {
  const selected = checks.flatMap((check) =>
    checkDeciders(reason, middleware, check),
  );
  const conflicting =
    reason === "unresolved-evidence"
      ? conflictingExpectations(checks).map((entry) => ({
          middlewareId: entry.middlewareId,
          ruleId: entry.ruleId,
          finding: "settled" as const,
        }))
      : [];
  const unique = new Map<string, DecidingRule>();
  for (const rule of [...selected, ...conflicting]) {
    const key = JSON.stringify([rule.middlewareId, rule.ruleId]);
    if (!unique.has(key)) {
      unique.set(key, withAdvice(reason, middleware, rule));
    }
  }
  return [...unique.values()];
}

function selectReason(
  event: MessageEvent,
  context: MessageContext,
  checks: readonly MiddlewareCheck[],
): Reason {
  const findings = checks.flatMap((check) => check.findings);
  if (findings.some((finding) => finding.outcome === "block")) {
    return "prohibited";
  }
  if (unavailableCheck(checks, findings)) {
    return "check-unavailable";
  }
  if (unresolvedCheck(context, checks, findings)) {
    return "unresolved-evidence";
  }
  if (findings.some((finding) => finding.outcome === "revise")) {
    return "norm-violation";
  }
  if (
    findings.some((finding) => finding.outcome === "approval-required") &&
    !hasApproval(event, context)
  ) {
    return "approval-required";
  }
  return "eligible";
}

/** The rules of one check that produced `reason`. */
function checkDeciders(
  reason: Reason,
  middleware: readonly Registration[],
  check: Observation,
): DecidingRule[] {
  if (reason === "check-unavailable" && check.status === "unavailable") {
    const registered =
      middleware.find((entry) => entry.id === check.middlewareId)?.rules ?? [];
    return registered.map((rule) => ({
      middlewareId: check.middlewareId,
      ruleId: rule.id,
      finding: "unavailable",
    }));
  }
  return check.findings.flatMap((finding) => {
    const kind = decidingFinding(finding, reason);
    return kind === undefined
      ? []
      : [
          {
            middlewareId: check.middlewareId,
            ruleId: finding.ruleId,
            finding: kind,
          },
        ];
  });
}

function withAdvice(
  reason: Reason,
  middleware: readonly Registration[],
  rule: DecidingRule,
): DecidingRule {
  const advice = registeredAdvice(
    reason,
    middleware
      .find((entry) => entry.id === rule.middlewareId)
      ?.rules.find((described) => described.id === rule.ruleId),
  );
  return advice === undefined ? rule : { ...rule, advice };
}

/** How a finding decided `reason`, or undefined when it did not. */
function decidingFinding(
  finding: PolicyFinding,
  reason: Reason,
): DecidingRule["finding"] | undefined {
  if (reason === "eligible") {
    return "choice" in finding ? "uncertain" : undefined;
  }
  if (!matchesReason(finding, reason)) {
    return undefined;
  }
  if (reason === "check-unavailable") {
    return "unavailable";
  }
  return finding.outcome === "hold" ? "uncertain" : "settled";
}

function registeredAdvice(
  reason: Reason,
  rule?: RuleDescription,
): string | undefined {
  if (reason === "eligible") {
    return rule?.guidance;
  }
  return rule?.feedback !== undefined &&
    validNextAction(reason, rule.feedback.nextAction)
    ? rule.feedback.text
    : undefined;
}

function unavailableCheck(
  checks: readonly MiddlewareCheck[],
  findings: readonly PolicyFinding[],
): boolean {
  return (
    checks.some((check) => check.status === "unavailable") ||
    findings.some(
      (finding) =>
        finding.outcome === "hold" && finding.reason === "check-unavailable",
    )
  );
}

function unresolvedCheck(
  context: MessageContext,
  checks: readonly MiddlewareCheck[],
  findings: readonly PolicyFinding[],
): boolean {
  return (
    context.gaps.length !== 0 ||
    findings.some((finding) => finding.outcome === "hold") ||
    conflictingExpectations(checks).length !== 0
  );
}

function hasApproval(event: MessageEvent, context: MessageContext): boolean {
  const approval = context.authorization;
  if (
    approval.kind !== "verified" ||
    approval.principal !== context.principal
  ) {
    return false;
  }
  const candidate = approval.candidate;
  const message = event.message;
  const sameRecipients =
    candidate.recipients.length === message.recipients.length &&
    candidate.recipients.every(
      (recipient, index) => recipient === message.recipients[index],
    );
  return (
    sameRecipients &&
    candidate.id === message.id &&
    candidate.text === message.text &&
    candidate.sender === message.sender
  );
}

/**
 * The rules whose unscoped opposing expectations conflict; a conflict is
 * unresolved, never a last-writer override.
 */
function conflictingExpectations(
  checks: ReadonlyArray<
    Pick<MiddlewareObservation, "middlewareId" | "expectations">
  >,
): ReadonlyArray<{ readonly middlewareId: string; readonly ruleId: string }> {
  const expectations = checks.flatMap((check) =>
    check.expectations.map((norm) => ({
      middlewareId: check.middlewareId,
      ruleId: norm.ruleId,
      expectation: norm.expectation,
      subjects: norm.subjects,
    })),
  );
  return expectations
    .filter((norm) =>
      expectations.some(
        (other) => opposing(norm, other) && overlapping(norm, other),
      ),
    )
    .map((norm) => ({ middlewareId: norm.middlewareId, ruleId: norm.ruleId }));
}

function opposing(
  left: Pick<NormExpectation, "expectation">,
  right: Pick<NormExpectation, "expectation">,
): boolean {
  const pair = new Set([left.expectation, right.expectation]);
  return pair.has("required") && pair.has("wait");
}

/** An expectation without subjects covers every subject. */
function overlapping(
  left: Pick<NormExpectation, "subjects">,
  right: Pick<NormExpectation, "subjects">,
): boolean {
  return (
    left.subjects.length === 0 ||
    right.subjects.length === 0 ||
    left.subjects.some((subject) => right.subjects.includes(subject))
  );
}

function matchesReason(finding: PolicyFinding, reason: Reason): boolean {
  const findingReasons = {
    pass: "eligible",
    "not-applicable": "eligible",
    block: "prohibited",
    revise: "norm-violation",
    "approval-required": "approval-required",
  } satisfies Record<Exclude<PolicyFinding["outcome"], "hold">, Reason>;
  if (reason === "eligible") {
    return false;
  }
  return finding.outcome === "hold"
    ? finding.reason === reason
    : findingReasons[finding.outcome] === reason;
}

/**
 * Each settled expectation and each uncertain pass whose rule registers
 * guidance becomes one entry; an uncertain one carries the decision provider's choice
 * and probability.
 */
function projectGuidance(
  middleware: readonly MessageMiddleware[],
  checks: readonly MiddlewareCheck[],
): FirewallCheck["guidance"] {
  return checks.flatMap((check) => {
    const entry = middleware.find(
      (candidate) => candidate.id === check.middlewareId,
    );
    const instructionFor = (ruleId: string) =>
      entry?.rules.find((rule) => rule.id === ruleId)?.guidance;
    const expected = check.expectations.flatMap((norm): NormGuidance[] => {
      const instruction = instructionFor(norm.ruleId);
      return instruction === undefined
        ? []
        : [
            {
              ruleId: norm.ruleId,
              expectation: norm.expectation,
              subjects: [...norm.subjects],
              middlewareId: check.middlewareId,
              instruction,
            },
          ];
    });
    const uncertain = check.findings.flatMap(
      (finding): UncertainNormGuidance[] => {
        if (!("choice" in finding)) {
          return [];
        }
        const instruction = instructionFor(finding.ruleId);
        return instruction === undefined
          ? []
          : [
              {
                middlewareId: check.middlewareId,
                ruleId: finding.ruleId,
                uncertain: {
                  choice: finding.choice,
                  probability: finding.probability,
                },
                instruction,
              },
            ];
      },
    );
    return [...expected, ...uncertain];
  });
}

/** A template cannot invite approval of a prohibition or suppress needed repair. */
function validNextAction(
  reason: Reason,
  action: FirewallCheck["feedback"][number]["nextAction"],
): boolean {
  return reason === "norm-violation"
    ? action === "revise" || action === "wait" || action === "stop"
    : action === defaultFeedback[reason][0]?.nextAction;
}
