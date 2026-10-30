/** @file Runs message checks in order and combines their findings into a firewall decision. */

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
  PrivateCheckTrace,
  RuleDescription,
} from "./contract/index.js";
import { composeDecision } from "./decision.js";

const utf8 = new TextEncoder();
/** Metadata is copied before code or retained audit can observe it. */
const middlewareRegistrationSchema = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  revision: Schema.NonEmptyTrimmedString,
  rules: Schema.NonEmptyArray(RuleDescription),
  provenance: Schema.optional(PrivateCheckTrace),
});

const failureReason = Schema.Literal(
  "unavailable",
  "timeout",
  "invalid-result",
  "budget",
  "defect",
);

/** Capture executable registration without retaining caller-owned metadata. */
export const captureRegistration = Effect.fn("Firewall.captureEntry")(
  function* (entry: MessageMiddleware) {
    const metadata = yield* decodeFrozen(middlewareRegistrationSchema, {
      id: entry.id,
      revision: entry.revision,
      rules: entry.rules,
      ...(entry.provenance === undefined
        ? {}
        : { provenance: entry.provenance }),
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
  },
);

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
  return Object.freeze({ event: capturedEvent, context: capturedContext });
});

/** Code policies receive exactly the same reference and advice validation as text. */
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
    result.findings.every((finding) => rules.has(finding.ruleId)) &&
    new Set(result.expectations.map((expectation) => expectation.ruleId))
      .size === result.expectations.length &&
    result.expectations.every(
      (expectation) =>
        rules.has(expectation.ruleId) &&
        new Set(expectation.subjects).size === expectation.subjects.length &&
        expectation.subjects.every((subject) => subjects.has(subject)),
    )
  );
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
    checks.push(yield* runMiddleware(entry, captured, settings, deadline));
  }
  return composeDecision(captured.context, middleware, checks);
});

/** Captured chains retain fixed executable registrations across policy activations. */
export const makeCapturedChain = Effect.fn("Firewall.makeCapturedChain")(
  function* (
    middleware: readonly MessageMiddleware[],
    settings: FirewallSettings,
  ) {
    if (
      new Set(middleware.map((entry) => entry.id)).size !== middleware.length
    ) {
      return yield* new CheckInputError({ reason: "registration" });
    }
    return (event: MessageEvent, context: MessageContext) =>
      checkMessage(event, context, middleware, settings);
  },
);

/** Captures one direction's ordered checks without exposing mutable registration. */
export const makeChain = Effect.fn("Firewall.makeChain")(function* (
  entries: readonly MessageMiddleware[],
  settings: FirewallSettings,
) {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    return yield* new CheckInputError({ reason: "registration" });
  }
  const captured = yield* Effect.forEach(entries, captureRegistration, {
    concurrency: 1,
  });
  return yield* makeCapturedChain(Object.freeze(captured), settings);
});
