/**
 * @file Shadow run for many-party protocols: judges every message in
 * `OH_CASES` (JSONL of `{id, owner, history, message}`, each message
 * `{sender, recipients, text}` with agent names as ids) against the protocol
 * text in `OH_RULE`, from the owner's side, with the form and state checks
 * and, when `JEV_KEY_FILE` names a key, the values question. Writes one JSONL
 * line per message to `OH_RESULTS`. Skipped unless the files are named.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { makeFirewall, TextRule } from "./index.js";
import { makeJevDecisionProvider } from "./jev.js";
import { makeProtocolCheck } from "./protocol-check.js";
import { makeProtocolForm } from "./protocol-form.js";
import { codeFixedParameters, makeProtocolState } from "./protocol-state.js";

interface Post {
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly text: string;
}

interface Case {
  readonly id: string;
  readonly owner: string;
  readonly history: readonly Post[];
  readonly message: Post;
}

const configured =
  process.env.OH_CASES !== undefined &&
  process.env.OH_RULE !== undefined &&
  process.env.OH_RESULTS !== undefined;

/** Runs only when the case, rule and result files are named. */
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

live(
  "shadow-judges a many-party conversation against a protocol",
  () =>
    Effect.gen(function* () {
      const rule = new TextRule({
        id: "protocol",
        kind: "norm",
        text: readFileSync(process.env.OH_RULE ?? "", "utf8").trim(),
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
      const cases = readFileSync(process.env.OH_CASES ?? "", "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Case);
      const output = process.env.OH_RESULTS ?? "";
      writeFileSync(output, "");
      yield* Effect.forEach(
        cases,
        (c) =>
          Effect.gen(function* () {
            const everyone = [
              ...new Set([
                c.owner,
                ...c.history.flatMap((post) => [
                  post.sender,
                  ...post.recipients,
                ]),
                c.message.sender,
                ...c.message.recipients,
              ]),
            ];
            const context = {
              agentId: c.owner,
              principal: `prn_${c.owner}`,
              participants: everyone.map((agentId) => ({
                agentId,
                principal: `prn_${agentId}`,
              })),
              history: c.history.map((post, index) => ({
                id: `msg_${String(index)}`,
                sender: post.sender,
                recipients: [...post.recipients] as [string, ...string[]],
                text: post.text,
                visibility: "runtime" as const,
                admission: "admitted" as const,
              })),
              facts: [],
              gaps: [],
            };
            const message = {
              id: "msg_candidate",
              sender: c.message.sender,
              recipients: [...c.message.recipients] as [string, ...string[]],
              text: c.message.text,
            };
            const result = yield* c.message.sender === c.owner
              ? firewall.checkOutgoing(message, context)
              : firewall.checkIncoming(message, context);
            const errorsOf = (id: string) => {
              const data = result.checks.find(
                (check) => check.middlewareId === id,
              )?.trace?.data;
              return data === undefined
                ? []
                : ((JSON.parse(data) as { errors?: string[] }).errors ?? []);
            };
            const values = result.checks.find(
              (check) => check.middlewareId === "values",
            )?.trace?.data;
            const p =
              values === undefined
                ? null
                : ((
                    JSON.parse(values) as {
                      answers: Record<
                        string,
                        { probabilities: Record<string, number> }
                      >;
                    }
                  ).answers["verdict-0"]?.probabilities["violation"] ?? null);
            appendFileSync(
              output,
              `${JSON.stringify({
                id: c.id,
                judgment: result.judgment,
                form: errorsOf("form"),
                state: errorsOf("state"),
                pViolation: p,
              })}\n`,
            );
          }),
        { concurrency: 8 },
      );
    }),
  3_600_000,
);
