/**
 * @file Experiment: the daemon of an agent that holds a protocol norm, in a
 * conversation whose other side need not hold it. Every message to or from
 * the holder goes through the firewall's checks. A message that passes goes
 * on, with the acts each recipient the daemon serves may send next. One that
 * fails goes nowhere; a quarantined responder answers its sender instead,
 * which is the counterpart for an incoming message and the holder's own agent
 * for its draft. The responder gets the norm, the conversation its addressee
 * can see, the message, the checks' reasons and the acts the addressee may
 * send instead, and its answer is an ordinary message.
 *
 * ```mermaid
 * flowchart TD
 *   M[Message to or from the holder] --> F[Form, state and values checks]
 *   F -->|pass| G[Deliver or send, with each served recipient's next acts]
 *   F -->|fail| R[Responder: norm, sender's view, reasons, sender's next acts]
 *   R --> A[Answer to the sender]
 * ```
 */

import { Data, Effect, Option, Schema } from "effect";
import type {
  CheckInputError,
  Firewall,
  FirewallCheck,
} from "./contract/index.js";
import { allowedNext, type NextAct } from "./protocol-state.js";

/** One message of the conversation, attributed by the daemon. */
export interface Post {
  readonly sender: string;
  readonly recipients: readonly [string, ...string[]];
  readonly text: string;
}

/** What the responder answers from. */
export interface ResponderInput {
  readonly protocol: string;
  /** The messages the addressee sent or received, oldest first. */
  readonly conversation: readonly Post[];
  readonly message: Post;
  readonly reasons: readonly string[];
  /** The acts the addressee may send instead. */
  readonly allowed: readonly NextAct[];
}

/** The responder could not answer. */
export class ResponderError extends Data.TaggedError("ResponderError")<{
  readonly reason: string;
}> {}

/**
 * Writes the answer to a message the checks refused. It sees only its input
 * and acts on nothing; its output is sent as the holder's message.
 */
export interface Responder {
  readonly respond: (
    input: ResponderInput,
  ) => Effect.Effect<string, ResponderError>;
}

/** The acts one agent may send next, and the text the daemon attaches for it. */
export interface Guidance {
  readonly agent: string;
  readonly allowed: readonly NextAct[];
  readonly text: string;
}

/** What the daemon does with one message. */
export type Outcome =
  | { readonly kind: "pass"; readonly guidance: readonly Guidance[] }
  | {
      readonly kind: "refused";
      readonly reasons: readonly string[];
      /** The answer to the message's sender. */
      readonly answer: string;
    };

/**
 * Build the daemon's handling for one holder and one protocol.
 * @param options What the daemon works from.
 * @param options.protocol The norm's protocol block, which declares the acts.
 * @param options.holder The agent whose daemon this is.
 * @param options.firewall A firewall with the protocol's checks in both directions.
 * @param options.responder Writes the answer to a refused message.
 * @returns `judge`, which handles one message given the admitted history.
 */
export function makeProtocolPipeline(options: {
  readonly protocol: string;
  readonly holder: string;
  readonly firewall: Firewall;
  readonly responder: Responder;
}): {
  readonly judge: (
    history: readonly Post[],
    message: Post,
  ) => Effect.Effect<Outcome, CheckInputError | ResponderError>;
} {
  const { protocol, holder, firewall, responder } = options;
  const judge = Effect.fn("judge")(function* (
    history: readonly Post[],
    message: Post,
  ) {
    const context = contextFor(holder, history, message);
    const draft = { ...message, id: "msg_candidate" };
    const outgoing = message.sender === holder;
    const result: FirewallCheck = outgoing
      ? yield* firewall.checkOutgoing(draft, context)
      : yield* firewall.checkIncoming(draft, context);
    if (result.judgment === "allow") {
      const served = outgoing ? message.recipients : [holder];
      return passed(protocol, [...history, message], served);
    }
    const reasons = reasonsOf(result);
    const answer = yield* responder.respond({
      protocol,
      conversation: history.filter((post) => sees(message.sender, post)),
      message,
      reasons,
      allowed: allowedNext(protocol, history, message.sender),
    });
    return { kind: "refused", reasons, answer } satisfies Outcome;
  });
  return { judge };
}

/**
 * Guidance as text for an agent that does not hold the protocol: how an act
 * is written, then each act it may send next.
 * @param protocol The norm's protocol block.
 * @param allowed The acts the agent may send next.
 * @returns The text the daemon attaches to the agent's copy of a message.
 */
export function guidanceText(
  protocol: string,
  allowed: readonly NextAct[],
): string {
  if (allowed.length === 0) {
    return "The protocol allows you no message now; wait for the next one.";
  }
  return [
    "The protocol allows you to send next exactly one of these acts, as the whole message:",
    ...allowed.map((act) => act.declaration),
    formSection(protocol),
  ].join("\n\n");
}

/** The firewall's view of the conversation: everything in it admitted and visible. */
function contextFor(holder: string, history: readonly Post[], message: Post) {
  const everyone = new Set(
    [...history, message].flatMap((post) => [post.sender, ...post.recipients]),
  );
  return {
    agentId: holder,
    principal: `prn_${holder}`,
    participants: [...everyone].map((agentId) => ({
      agentId,
      principal: `prn_${agentId}`,
    })),
    history: history.map((post, index) => ({
      ...post,
      id: `msg_${String(index)}`,
      visibility: "runtime" as const,
      admission: "admitted" as const,
    })),
    facts: [],
    gaps: [],
  };
}

/** A passed message, with what each agent the daemon serves may send after it. */
function passed(
  protocol: string,
  after: readonly Post[],
  served: readonly string[],
): Outcome {
  return {
    kind: "pass",
    guidance: served.map((agent) => {
      const allowed = allowedNext(protocol, after, agent);
      return { agent, allowed, text: guidanceText(protocol, allowed) };
    }),
  };
}

/** Whether `agent` sent or received `post`, so its answer may draw on it. */
function sees(agent: string, post: Post): boolean {
  return post.sender === agent || post.recipients.includes(agent);
}

/** The protocol text's "message form" section: how any act is written. */
function formSection(protocol: string): string {
  const lines = protocol.split("\n");
  const start = lines.findIndex((line) => /^message form\s*$/u.test(line));
  if (start < 0) {
    return "";
  }
  const end = lines.findIndex(
    (line, index) => index > start && /^\S/u.test(line),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const decodeErrors = Schema.decodeUnknownOption(
  Schema.parseJson(
    Schema.Struct({ errors: Schema.optional(Schema.Array(Schema.String)) }),
  ),
);

/**
 * The checks' reasons for refusing: the form and state errors, or, when code
 * found none, the values finding. The values question presumes a well-formed
 * act sent at an allowed point, so its verdict on anything else is dropped.
 */
function reasonsOf(result: FirewallCheck): readonly string[] {
  const errors = result.checks.flatMap(
    (check) =>
      Option.getOrUndefined(decodeErrors(check.trace?.data ?? ""))?.errors ??
      [],
  );
  if (errors.length > 0) {
    return errors;
  }
  return result.checks
    .filter((check) =>
      check.findings.some((finding) => finding.outcome !== "pass"),
    )
    .map(
      (check) =>
        `the ${check.middlewareId} check: a value carries something its description does not ask for`,
    );
}
