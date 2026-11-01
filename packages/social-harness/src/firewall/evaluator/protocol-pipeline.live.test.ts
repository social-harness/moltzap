/**
 * @file Offline run of the holder's daemon: judges each message in `PP_CASES`
 * (JSONL of `{id, rule, holder, history, message}`, `rule` a protocol text
 * file) with the form and state checks, and the values question when
 * `JEV_KEY_FILE` names a key. A refused message is answered by a responder
 * that runs `claude -p` with no tools, MCP servers, settings or session, from
 * the empty directory `PP_RESPONDER_DIR`. The first act the answer spells out
 * is then judged as the sender's next message, to see whether following the
 * answer gets the message through, unless it leaves a value for the sender
 * to supply as <what is needed>. Writes one JSONL line per case to
 * `PP_RESULTS`. Skipped unless the files are named.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { makeFirewall, TextRule } from "./index.js";
import { makeJevDecisionProvider } from "./jev.js";
import { makeProtocolCheck } from "./protocol-check.js";
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
  readonly rule: string;
  readonly holder: string;
  readonly history: readonly Post[];
  readonly message: Post;
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
      const pipelines = new Map<
        string,
        ReturnType<typeof makeProtocolPipeline>
      >();
      const pipelineFor = Effect.fn("pipelineFor")(function* (c: Case) {
        const key = `${c.rule}\u0000${c.holder}`;
        const known = pipelines.get(key);
        if (known !== undefined) {
          return known;
        }
        const protocol = readFileSync(c.rule, "utf8").trim();
        const rule = new TextRule({
          id: "protocol",
          kind: "norm",
          text: protocol,
          feedback: {
            text: "This message does not follow the protocol.",
            nextAction: "revise",
          },
        });
        const checks = [
          makeProtocolForm({ id: "form", rule: { ...rule, id: "form" } }),
          makeProtocolState({ id: "state", rule: { ...rule, id: "state" } }),
          ...(process.env.JEV_KEY_FILE === undefined
            ? []
            : [
                makeProtocolCheck({
                  id: "values",
                  rules: [rule],
                  provider: makeJevDecisionProvider({
                    apiKey: Redacted.make(
                      readFileSync(process.env.JEV_KEY_FILE, "utf8").trim(),
                    ),
                    model: "jev-1.13.0",
                  }),
                  question: VALUES_QUESTION,
                  hiddenParameters: codeFixedParameters(rule.text),
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
          holder: c.holder,
          firewall,
          responder,
        });
        pipelines.set(key, pipeline);
        return pipeline;
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
            const pipeline = yield* pipelineFor(c);
            const outcome = yield* pipeline.judge(c.history, c.message);
            const suggested =
              outcome.kind === "refused" ? firstAct(outcome.answer) : undefined;
            const asks =
              suggested !== undefined && /<[^<>\n]+>/u.test(suggested);
            const resend =
              suggested === undefined || asks
                ? undefined
                : yield* pipeline.judge(c.history, {
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
                    : resend.kind === "pass"
                      ? "pass"
                      : resend.reasons,
              })}\n`,
            );
          }),
        { concurrency: 6 },
      );
    }),
  3_600_000,
);
