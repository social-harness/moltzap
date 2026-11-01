/**
 * @file Experiment: the holder's daemon when it holds several norms. Each
 * message goes to the pipeline of the one norm that governs it: the norm
 * whose acts it uses, else the norm with a request open in the conversation,
 * else the norm a selector picks from their names and descriptions. A
 * message no norm governs is ordinary and passes unchecked. Any participant
 * may send a get-norm act naming a norm; code answers it with that norm's text,
 * and it reaches no agent. A responder can therefore answer a refusal by
 * pointing at the norm instead of explaining it (see pointerResponder).
 */

import { Effect } from "effect";
import type { CheckInputError, DecisionProvider } from "./contract/index.js";
import type {
  Outcome,
  Post,
  Responder,
  ResponderError,
} from "./protocol-pipeline.js";
import { declaredActs, parseAct } from "./protocol-form.js";
import { hasOpenRequest } from "./protocol-state.js";

/** One norm the holder holds, with the pipeline that checks messages under it. */
export interface HeldNorm {
  readonly name: string;
  readonly description: string;
  /** The whole norm, as `get-norm` returns it. */
  readonly text: string;
  /** The protocol block the pipeline checks against. */
  readonly protocol: string;
  readonly judge: (
    history: readonly Post[],
    message: Post,
  ) => Effect.Effect<Outcome, CheckInputError | ResponderError>;
}

/** Picks the norm that governs a message, by name, or none. */
export interface Selector {
  readonly select: (input: {
    readonly norms: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
    }>;
    readonly conversation: readonly Post[];
    readonly message: Post;
  }) => Effect.Effect<string | undefined>;
}

/** What the router does with one message. */
export type Routed =
  | (Outcome & { readonly norm: string })
  | { readonly kind: "norm-text"; readonly answer: string }
  | { readonly kind: "ungoverned" };

/**
 * Build the router over the holder's norms.
 * @param options What the router works from.
 * @param options.norms The norms the holder holds, each with its pipeline.
 * @param options.selector Picks a norm when neither acts nor state settle it.
 * @returns `judge`, which handles one message given the admitted history.
 */
export function makeNormRouter(options: {
  readonly norms: readonly HeldNorm[];
  readonly selector: Selector;
}): {
  readonly judge: (
    history: readonly Post[],
    message: Post,
  ) => Effect.Effect<Routed, CheckInputError | ResponderError>;
} {
  const { norms, selector } = options;
  const judge = Effect.fn("route")(function* (
    history: readonly Post[],
    message: Post,
  ) {
    const asked = requestedNorm(message.text);
    if (asked !== undefined) {
      return { kind: "norm-text", answer: normText(norms, asked) } as const;
    }
    const settled = byActs(norms, message.text) ?? byState(norms, history);
    const name =
      settled?.name ??
      (yield* selector.select({ norms, conversation: history, message }));
    const norm = norms.find((held) => held.name === name);
    if (norm === undefined) {
      return { kind: "ungoverned" } as const;
    }
    const outcome = yield* norm.judge(history, message);
    return { ...outcome, norm: norm.name };
  });
  return { judge };
}

/**
 * A responder that answers in code: it names the norm the message broke,
 * says what the checks found, and how to read the norm.
 * @param name The norm's name.
 * @returns The responder for that norm's pipeline.
 */
export function pointerResponder(name: string): Responder {
  return {
    respond: (input) =>
      Effect.succeed(
        [
          `Your message was not passed on: it does not follow the norm "${name}", which governs this conversation (${input.reasons.join("; ") || "it is not a message the norm allows"}).`,
          `To read the norm, send this message, exactly:\n\n${getNormRequest(name)}\n\nThen send a message that follows it.`,
        ].join("\n\n"),
      ),
  };
}

/**
 * The message that asks a holder's daemon for a norm's text.
 * @param name Which of the holder's norms to ask for.
 * @returns The get-norm act, as a whole message.
 */
export function getNormRequest(name: string): string {
  return `(get-norm\n  :name ${name})`;
}

/**
 * The selector as one Jev question: which of the holder's norms, if any,
 * governs the message, from their names and descriptions and the
 * conversation so far.
 * @param provider The decision provider.
 * @returns The selector; when the provider fails it picks no norm.
 */
export function makeJevSelector(provider: DecisionProvider): Selector {
  return {
    select: ({ norms, conversation, message }) =>
      provider
        .decide({
          stage: "applicability",
          state: JSON.stringify({
            norms: norms.map(({ name, description }) => ({
              name,
              description,
            })),
            conversation: conversation.map(({ sender, recipients, text }) => ({
              from: sender,
              to: recipients,
              text,
            })),
            message: {
              from: message.sender,
              to: message.recipients,
              text: message.text,
            },
          }),
          questions: {
            norm: {
              ruleId: "norms",
              purpose: "assessment",
              instructions:
                "The agent receiving or sending the message under review holds the norms listed. Which norm governs this message: which one says how a message like it, at this point in this conversation, must be written? Answer none if no listed norm covers it.",
              criteria: {
                ...Object.fromEntries(
                  norms.map(({ name, description }) => [name, description]),
                ),
                none: "No listed norm covers this message.",
              },
            },
          },
        })
        .pipe(
          Effect.map((response) => response.answers.norm?.choice),
          Effect.map((choice) => (choice === "none" ? undefined : choice)),
          Effect.orElseSucceed(() => undefined),
        ),
  };
}

/** The norm name a get-norm message asks for, "" when it names none. */
function requestedNorm(text: string): string | undefined {
  if (!/^\s*\(get-norm\b/u.test(text)) {
    return undefined;
  }
  return /:name\s+([^\s)]+)/u.exec(text)?.[1] ?? "";
}

/** The asked-for norm's text, or the list of held norms when the name matches none. */
function normText(norms: readonly HeldNorm[], name: string): string {
  const norm = norms.find((held) => held.name === name);
  if (norm !== undefined) {
    return norm.text;
  }
  return [
    "Norms held here, by name; send a get-norm act naming one to read it:",
    ...norms.map((held) => `  ${held.name}: ${held.description}`),
  ].join("\n");
}

/** The one norm that declares the act `text` carries, if exactly one does. */
function byActs(
  norms: readonly HeldNorm[],
  text: string,
): HeldNorm | undefined {
  const parsed = parseAct(text);
  if (typeof parsed === "string") {
    return undefined;
  }
  const declaring = norms.filter((norm) =>
    declaredActs(norm.protocol).has(parsed.name),
  );
  return declaring.length === 1 ? declaring[0] : undefined;
}

/** The one norm with a request open in the conversation, if exactly one has. */
function byState(
  norms: readonly HeldNorm[],
  history: readonly Post[],
): HeldNorm | undefined {
  const open = norms.filter((norm) => hasOpenRequest(norm.protocol, history));
  return open.length === 1 ? open[0] : undefined;
}
