/**
 * @file Offline run of the holder's daemon: judges each message in `PP_CASES`
 * with the form and state checks, and the values question when
 * `JEV_KEY_FILE` names a key. A case is JSONL `{id, holder, history, message}`
 * plus either `rule`, one protocol text file that governs every message, or
 * `norms`, a list of `{doc, rule}` (a norm document and its protocol block)
 * routed by norm-router, whose selector is then the Jev applicability
 * question. A refused message is answered by a responder that runs `claude -p`
 * with no tools, MCP servers, settings or session, from the empty directory
 * `PP_RESPONDER_DIR`, or, when the case sets `responder: "pointer"`, by a
 * pointer to the norm in code. The first act an answer spells out is then
 * judged as the sender's next message, to see whether following the answer
 * gets the message through, unless it leaves a value for the sender to
 * supply in angle brackets. Writes one JSONL line per case to `PP_RESULTS`.
 * Skipped unless the files are named.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import type { DecisionProvider } from "./contract/index.js";
import { makeFirewall, TextRule } from "./index.js";
import { makeJevDecisionProvider } from "./jev.js";
import { makeProtocolCheck } from "./protocol-check.js";
import {
  type HeldNorm,
  makeJevSelector,
  makeNormRouter,
  pointerResponder,
  type Routed,
  type Selector,
} from "./norm-router.js";
import { makeProtocolForm } from "./protocol-form.js";
import {
  guidanceText,
  makeProtocolPipeline,
  type Post,
  type Responder,
  ResponderError,
  type ResponderInput,
} from "./protocol-pipeline.js";
import { codeFixedParameters, makeProtocolState } from "./protocol-state.js";

interface Case {
  readonly id: string;
  readonly holder: string;
  readonly rule?: string;
  readonly norms?: ReadonlyArray<{
    readonly doc: string;
    readonly rule: string;
  }>;
  readonly responder?:
    | "answer"
    | "pointer"
    | "repair"
    | "repair-code"
    | "registered";
  readonly history: readonly Post[];
  readonly message: Post;
}

/** A norm document's name, description and registered feedback, from its frontmatter, and its body. */
function normDocument(path: string): {
  readonly name: string;
  readonly description: string;
  readonly feedback: string;
  readonly text: string;
} {
  const doc = readFileSync(path, "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(doc);
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(front?.[1] ?? "")?.[1]?.trim() ??
    "";
  return {
    name: field("name"),
    description: field("description"),
    feedback: /^\s+text:\s*(.+)$/mu.exec(front?.[1] ?? "")?.[1]?.trim() ?? "",
    text: doc.slice(front?.[0].length ?? 0).trim(),
  };
}

/** A refusal reason that is about timing alone, which repair answers in code. */
const TIMING = /may not be sent at this point/u;

/**
 * Repair for the sending agent's own draft: what failed and the acts allowed
 * now, in code; for a form or value mistake, also the corrected message from
 * the quarantined model.
 */
function repairResponder(model?: Responder): Responder {
  return {
    respond: (input) => {
      const code = [
        `Your draft was not sent. What the checks found: ${input.reasons.join("; ")}.`,
        guidanceText(input.protocol, input.allowed),
      ].join("\n\n");
      return model === undefined ||
        input.reasons.every((reason) => TIMING.test(reason))
        ? Effect.succeed(code)
        : model
            .respond(input)
            .pipe(Effect.map((fix) => `${code}\n\nSuggested message:\n${fix}`));
    },
  };
}

const configured =
  process.env.PP_CASES !== undefined &&
  process.env.PP_RESULTS !== undefined &&
  process.env.PP_RESPONDER_DIR !== undefined;

/** Runs only when the case, result and responder paths are named. */
const live = configured ? it.live : it.live.skip;

const VALUES_QUESTION = {
  instructions: (ruleId: string) =>
    `Under rule "${ruleId}", the message under review is a well-formed act sent at a point the rule allows; code has already checked its form, the conversation state, and the values it fixes, which are left out. Judge only the values shown against their descriptions and the rule's values section: does every value carry only what its description asks for?`,
  criteria: {
    allowed: "Every value carries only what its description asks for.",
    violation:
      "Some value carries something its description does not ask for or that the values section forbids.",
    unclear: "The conversation does not show enough to decide.",
  },
};

/** What the responder is told it is doing; the case data follows as the prompt. */
const RESPONDER_INSTRUCTIONS = `You write one message for an agent's messaging daemon. The agent follows the protocol given below. A message in the conversation did not follow the protocol, so the daemon did not pass it on; your message goes back to that message's sender instead.

Write to the sender directly, in this order:
1. In one or two plain sentences, what was wrong with its message.
2. The act it should send instead, written out in full in the protocol's message form, with every value filled in from what its message and the conversation say. If the protocol allows it several acts, give the one that fits what its message was trying to do. If its message does not say enough to fill a value, write that value as <what is needed> and ask for it instead of guessing.
3. If the protocol allows it no act now, or no allowed act does what its message was trying to do, give no act; say what happens next instead.

Use only what the conversation shows; add nothing about the agent, its principal or anyone else. Output only the message.`;

/** The case data the responder answers from. */
function responderPrompt(input: ResponderInput): string {
  const show = (post: Post) =>
    `from ${post.sender} to ${post.recipients.join(", ")}:\n${post.text}`;
  return [
    "PROTOCOL",
    input.protocol,
    "CONVERSATION SO FAR, AS THE SENDER SEES IT",
    input.conversation.map(show).join("\n\n") || "(empty)",
    "THE MESSAGE THAT DID NOT FOLLOW THE PROTOCOL",
    show(input.message),
    "WHAT THE CHECKS FOUND",
    input.reasons.join("\n") || "(no detail)",
    "WHAT THE PROTOCOL ALLOWS THE SENDER NOW",
    guidanceText(input.protocol, input.allowed),
  ].join("\n\n");
}

/**
 * The responder as a `claude -p` call that can read nothing but its prompt
 * and act on nothing: no tools, MCP servers, setting sources, slash commands
 * or saved session, run from an empty directory.
 */
function claudeResponder(model: string, directory: string): Responder {
  return {
    respond: (input) =>
      Command.make(
        "claude",
        "-p",
        "--model",
        model,
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--system-prompt",
        RESPONDER_INSTRUCTIONS,
        "--output-format",
        "text",
      ).pipe(
        Command.workingDirectory(directory),
        Command.feed(responderPrompt(input)),
        Command.string,
        Effect.map((text) => text.trim()),
        Effect.mapError(
          (error) => new ResponderError({ reason: String(error) }),
        ),
        Effect.provide(NodeContext.layer),
      ),
  };
}

/** The first act written out in `text`, from its "(name" line to its closing ")". */
function firstAct(text: string): string | undefined {
  return /^\s*\([a-z][a-z-]*\s*\n(?:[^\n()]*\n)*?[^\n()]*\)/mu
    .exec(text)?.[0]
    .trim();
}

live(
  "answers refused messages and attaches next acts to passed ones",
  () =>
    Effect.gen(function* () {
      const responder = claudeResponder(
        process.env.PP_MODEL ?? "claude-sonnet-5-5",
        process.env.PP_RESPONDER_DIR ?? "",
      );
      const provider: DecisionProvider | undefined =
        process.env.JEV_KEY_FILE === undefined
          ? undefined
          : makeJevDecisionProvider({
              apiKey: Redacted.make(
                readFileSync(process.env.JEV_KEY_FILE, "utf8").trim(),
              ),
              model: "jev-1.13.0",
            });
      const heldNorm = Effect.fn("heldNorm")(function* (
        holder: string,
        protocolFile: string,
        doc: {
          readonly name: string;
          readonly description: string;
          readonly feedback: string;
          readonly text: string;
        },
        mode: "answer" | "pointer" | "repair" | "repair-code" | "registered",
      ) {
        const protocol = readFileSync(protocolFile, "utf8").trim();
        const rule = (id: string) =>
          new TextRule({
            id,
            kind: "norm",
            text: protocol,
            feedback: {
              text: "This message does not follow the protocol.",
              nextAction: "revise",
            },
          });
        const checks = [
          makeProtocolForm({ id: "form", rule: rule("form") }),
          makeProtocolState({ id: "state", rule: rule("state") }),
          ...(provider === undefined
            ? []
            : [
                makeProtocolCheck({
                  id: "values",
                  rules: [rule("protocol")],
                  provider,
                  question: VALUES_QUESTION,
                  hiddenParameters: codeFixedParameters(protocol),
                }),
              ]),
        ];
        const firewall = yield* makeFirewall({
          incoming: checks,
          outgoing: checks,
          settings: {
            timeoutMilliseconds: 120_000,
            middlewareTimeoutMilliseconds: 60_000,
            maximumInputBytes: 4_000_000,
            maximumResultBytes: 2_000_000,
          },
        });
        const pipeline = makeProtocolPipeline({
          protocol,
          holder,
          firewall,
          responder:
            mode === "pointer"
              ? pointerResponder(doc.name)
              : mode === "repair"
                ? repairResponder(responder)
                : mode === "repair-code"
                  ? repairResponder()
                  : mode === "registered"
                    ? {
                        respond: () =>
                          Effect.succeed(
                            doc.feedback ||
                              `This message does not follow the ${doc.name} protocol.`,
                          ),
                      }
                    : responder,
        });
        const norm: HeldNorm = { ...doc, protocol, judge: pipeline.judge };
        return norm;
      });
      const routers = new Map<string, ReturnType<typeof makeNormRouter>>();
      const routerFor = Effect.fn("routerFor")(function* (c: Case) {
        const mode = c.responder ?? "answer";
        const key = JSON.stringify([c.holder, c.rule, c.norms, mode]);
        const known = routers.get(key);
        if (known !== undefined) {
          return known;
        }
        const norms =
          c.norms === undefined
            ? [
                yield* heldNorm(
                  c.holder,
                  c.rule ?? "",
                  {
                    name: "protocol",
                    description: "the protocol",
                    feedback: "",
                    text: "",
                  },
                  mode,
                ),
              ]
            : yield* Effect.forEach(c.norms, (norm) =>
                heldNorm(c.holder, norm.rule, normDocument(norm.doc), mode),
              );
        const only = norms.length === 1 ? norms[0]?.name : undefined;
        const selector: Selector =
          provider === undefined || only !== undefined
            ? { select: () => Effect.succeed(only) }
            : makeJevSelector(provider);
        const router = makeNormRouter({ norms, selector });
        routers.set(key, router);
        return router;
      });
      const cases = readFileSync(process.env.PP_CASES ?? "", "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Case);
      const output = process.env.PP_RESULTS ?? "";
      writeFileSync(output, "");
      yield* Effect.forEach(
        cases,
        (c) =>
          Effect.gen(function* () {
            const router = yield* routerFor(c);
            const outcome: Routed = yield* router.judge(c.history, c.message);
            const suggested =
              outcome.kind === "refused" &&
              (c.responder ?? "answer") === "answer"
                ? firstAct(outcome.answer)
                : undefined;
            const asks =
              suggested !== undefined && /<[^<>\n]+>/u.test(suggested);
            const resend =
              suggested === undefined || asks
                ? undefined
                : yield* router.judge(c.history, {
                    ...c.message,
                    text: suggested,
                  });
            appendFileSync(
              output,
              `${JSON.stringify({
                id: c.id,
                outcome:
                  outcome.kind === "pass"
                    ? {
                        kind: "pass",
                        norm: outcome.norm,
                        guidance: outcome.guidance.map((g) => ({
                          agent: g.agent,
                          acts: g.allowed.map((act) => act.name),
                          text: g.text,
                        })),
                      }
                    : outcome,
                suggested,
                asks,
                resend:
                  resend === undefined
                    ? undefined
                    : resend.kind === "refused"
                      ? resend.reasons
                      : resend.kind,
              })}\n`,
            );
          }),
        { concurrency: 6 },
      );
    }),
  3_600_000,
);
