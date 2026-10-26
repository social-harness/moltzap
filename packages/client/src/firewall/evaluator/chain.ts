/** @file Sequential checking middleware; Client retains exclusive admission authority. */

import { Clock, Effect, Either, Schema } from "effect";
import {
  captureResult,
  CheckInputError,
  decodeFrozen,
  type FirewallSettings,
  MessageContext,
  type MessageEvent,
  type MessageMiddleware,
  type MiddlewareCheck,
  MiddlewareError,
  MiddlewareInput,
  MiddlewareResult,
  type PolicyFinding,
  RuleDescription,
} from "./contract/index.js";
import { composeDecision } from "./decision.js";

const utf8 = new TextEncoder();
const registration = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  revision: Schema.NonEmptyTrimmedString,
  rules: Schema.NonEmptyArray(RuleDescription),
});
const failureReason = Schema.Literal(
  "unavailable",
  "timeout",
  "invalid-result",
  "budget",
  "defect",
);

const captureEntry = Effect.fn("Firewall.captureEntry")(function* (
  entry: MessageMiddleware,
) {
  const metadata = yield* decodeFrozen(registration, {
    id: entry.id,
    revision: entry.revision,
    rules: entry.rules,
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
  if (
    new Set(metadata.rules.map((rule) => rule.id)).size !==
    metadata.rules.length
  ) {
    return yield* new CheckInputError({ reason: "registration" });
  }
  const check = yield* Effect.try({
    try: () => entry.check.bind(entry),
    catch: () => new CheckInputError({ reason: "registration" }),
  });
  return Object.freeze({ ...metadata, check });
});

const captureInput = Effect.fn("Firewall.captureInput")(function* (
  event: MessageEvent,
  context: MessageContext,
) {
  const capturedEvent = yield* decodeFrozen(
    MiddlewareInput.fields.event,
    event,
  ).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "message" })),
    ),
  );
  const capturedContext = yield* decodeFrozen(MessageContext, context).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "context" })),
    ),
  );
  const message = capturedEvent.message;
  const references = [
    message.id,
    ...capturedContext.history.map((entry) => entry.id),
    ...capturedContext.facts.map((entry) => entry.id),
  ];
  const attribution =
    event.direction === "outgoing"
      ? message.sender === capturedContext.agentId
      : message.recipients.includes(capturedContext.agentId);
  if (
    !attribution ||
    new Set(message.recipients).size !== message.recipients.length
  ) {
    return yield* new CheckInputError({ reason: "message" });
  }
  if (
    new Set(references).size !== references.length ||
    new Set(
      capturedContext.participants.map((participant) => participant.agentId),
    ).size !== capturedContext.participants.length
  ) {
    return yield* new CheckInputError({ reason: "context" });
  }
  return { event: capturedEvent, context: capturedContext };
});

/** Code policies receive exactly the same reference and advice validation as English. */
function validResult(
  result: MiddlewareResult,
  middleware: MessageMiddleware,
  input: MiddlewareInput,
): boolean {
  const rules = new Map(middleware.rules.map((rule) => [rule.id, rule]));
  const covered = new Set(result.findings.map((finding) => finding.ruleId));
  const subjects = new Set(
    input.context.history
      .filter(
        (message) =>
          message.admission === "admitted" && message.visibility === "runtime",
      )
      .map((message) => message.id),
  );
  if (input.event.direction === "incoming") {
    subjects.add(input.event.message.id);
  }
  return (
    middleware.rules.every((rule) => covered.has(rule.id)) &&
    result.findings.every((finding) =>
      validFinding(finding, input.event, rules.get(finding.ruleId)),
    ) &&
    new Set(result.expectations.map((norm) => norm.ruleId)).size ===
      result.expectations.length &&
    result.expectations.every(
      (norm) =>
        rules.get(norm.ruleId)?.kind === "norm" &&
        new Set(norm.subjects).size === norm.subjects.length &&
        norm.subjects.every((subject) => subjects.has(subject)),
    )
  );
}

/** Only a norm may pass uncertain; any other unsettled rule must hold. */
function validFinding(
  finding: PolicyFinding,
  event: MessageEvent,
  rule?: RuleDescription,
): boolean {
  if (rule === undefined) {
    return false;
  }
  if ("choice" in finding) {
    return rule.kind === "norm";
  }
  if (finding.outcome === "revise") {
    return event.direction === "outgoing" && rule.kind === "norm";
  }
  return true;
}

const invokeMiddleware = Effect.fn("Firewall.invokeMiddleware")(function* (
  middleware: MessageMiddleware,
  input: MiddlewareInput,
  settings: FirewallSettings,
) {
  if (
    utf8.encode(JSON.stringify(input)).byteLength > settings.maximumInputBytes
  ) {
    return yield* new MiddlewareError({ reason: "budget" });
  }
  const returned = yield* Effect.suspend(() => middleware.check(input));
  const result = yield* decodeFrozen(MiddlewareResult, returned).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new MiddlewareError({ reason: "invalid-result" })),
    ),
  );
  if (
    utf8.encode(JSON.stringify(result)).byteLength > settings.maximumResultBytes
  ) {
    return yield* new MiddlewareError({ reason: "budget" });
  }
  if (!validResult(result, middleware, input)) {
    return yield* new MiddlewareError({ reason: "invalid-result" });
  }
  return result;
});

function unavailable(
  middleware: MessageMiddleware,
  failure: MiddlewareError,
  elapsedMilliseconds: number,
): MiddlewareCheck {
  return {
    middlewareId: middleware.id,
    revision: middleware.revision,
    status: "unavailable",
    findings: [],
    expectations: [],
    elapsedMilliseconds,
    failure: new MiddlewareError({
      reason: Schema.is(failureReason)(failure.reason)
        ? failure.reason
        : "unavailable",
    }),
  };
}

const runMiddleware = Effect.fn("Firewall.runMiddleware")(function* (
  middleware: MessageMiddleware,
  input: MiddlewareInput,
  settings: FirewallSettings,
  deadline: number,
): Effect.fn.Return<MiddlewareCheck> {
  const started = yield* Clock.currentTimeMillis;
  const remaining = deadline - started;
  if (remaining <= 0) {
    return unavailable(
      middleware,
      new MiddlewareError({ reason: "timeout" }),
      0,
    );
  }
  const timeout = Math.min(remaining, settings.middlewareTimeoutMilliseconds);
  const returned = yield* captureResult(
    invokeMiddleware(middleware, input, settings).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new MiddlewareError({ reason: "timeout" }),
      }),
    ),
    () => new MiddlewareError({ reason: "defect" }),
  ).pipe(Effect.withSpan("Firewall.boundedCheck"));
  const elapsedMilliseconds = (yield* Clock.currentTimeMillis) - started;
  return Either.match(returned, {
    onLeft: (failure) => unavailable(middleware, failure, elapsedMilliseconds),
    onRight: (result) =>
      elapsedMilliseconds > timeout
        ? unavailable(
            middleware,
            new MiddlewareError({ reason: "timeout" }),
            elapsedMilliseconds,
          )
        : {
            middlewareId: middleware.id,
            revision: middleware.revision,
            status: "completed",
            elapsedMilliseconds,
            findings: result.findings,
            expectations: result.expectations,
            trace: result.trace,
          },
  });
});

const checkMessage = Effect.fn("Firewall.check")(function* (
  event: MessageEvent,
  context: MessageContext,
  middleware: readonly MessageMiddleware[],
  settings: FirewallSettings,
) {
  const captured = yield* captureInput(event, context);
  const deadline =
    (yield* Clock.currentTimeMillis) + settings.timeoutMilliseconds;
  const checks: MiddlewareCheck[] = [];
  for (const entry of middleware) {
    const previous = Object.freeze(
      checks.map((check) =>
        Object.freeze({
          middlewareId: check.middlewareId,
          revision: check.revision,
          status: check.status,
          findings: Object.freeze(check.findings),
          expectations: Object.freeze(check.expectations),
        }),
      ),
    );
    const input = Object.freeze({ ...captured, previous });
    checks.push(yield* runMiddleware(entry, input, settings, deadline));
  }
  return composeDecision(captured.context, middleware, checks);
});

/** Captures one direction's ordered checks without exposing mutable registration. */
export const makeChain = Effect.fn("Firewall.makeChain")(function* (
  entries: readonly MessageMiddleware[],
  settings: FirewallSettings,
) {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    return yield* new CheckInputError({ reason: "registration" });
  }
  const captured = yield* Effect.forEach(entries, captureEntry, {
    concurrency: 1,
  });
  const middleware = Object.freeze(captured);
  return (event: MessageEvent, context: MessageContext) =>
    checkMessage(event, context, middleware, settings);
});
