/**
 * @file The holder's daemon on a two-role poll protocol: which acts it offers
 * next, what its responder is given for a refused message, and the next acts
 * it attaches to a message that passes.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeFirewall, TextRule } from "./index.js";
import { makeProtocolForm } from "./protocol-form.js";
import {
  type Guidance,
  makeProtocolPipeline,
  type Post,
  type ResponderInput,
} from "./protocol-pipeline.js";
import {
  allowedNext,
  makeProtocolState,
  type NextAct,
} from "./protocol-state.js";

const PROTOCOL = `protocol poll

message form
  Every message is exactly one act and nothing else. A list is written [first | second].

meetings
  ask opens a poll. The Asker gives it an id in :meeting that the conversation has not used before.

acts sent by the Asker

  (ask
    :meeting      a new poll id
    :members      a list of every Answerer, each "agent:<name>"
    :candidates   a list of options, each "<n> <day> <start>–<end>")
  when opens

  (decide
    :meeting      the open poll's id
    :option       the number of the chosen option)
  when answers; every member has sent reply; final
  check :option is a number in every reply :free

acts sent by the Answerer

  (reply
    :meeting      the open poll's id
    :free         a list of the numbers of every option the Answerer can attend, or none)
  when answers; sent by a member; once per sender
  check :free items are numbers in the latest ask :candidates
`;

const POLL = "p1";

const names = (acts: readonly NextAct[]) => acts.map((act) => act.name);

const guided = (guidance: readonly Guidance[]) =>
  guidance.map((g) => [g.agent, names(g.allowed)]);
const ASK: Post = {
  sender: "asker",
  recipients: ["bea", "cal"],
  text: `(ask\n  :meeting ${POLL}\n  :members [agent:bea | agent:cal]\n  :candidates [1 Mon 10:00–10:30 | 2 Tue 11:00–11:30])`,
};
const reply = (sender: string, free: string): Post => ({
  sender,
  recipients: ["asker"],
  text: `(reply\n  :meeting ${POLL}\n  :free ${free})`,
});

const pipeline = (responses: ResponderInput[]) =>
  Effect.gen(function* () {
    const rule = (id: string) =>
      new TextRule({
        id,
        kind: "norm",
        text: PROTOCOL,
        feedback: { text: "Follow the poll protocol.", nextAction: "revise" },
      });
    const checks = [
      makeProtocolForm({ id: "form", rule: rule("form") }),
      makeProtocolState({ id: "state", rule: rule("state") }),
    ];
    const firewall = yield* makeFirewall({
      incoming: checks,
      outgoing: checks,
      settings: {
        timeoutMilliseconds: 5_000,
        middlewareTimeoutMilliseconds: 5_000,
        maximumInputBytes: 1_000_000,
        maximumResultBytes: 1_000_000,
      },
    });
    return makeProtocolPipeline({
      protocol: PROTOCOL,
      holder: "asker",
      firewall,
      responder: {
        respond: (input) =>
          Effect.sync(() => {
            responses.push(input);
            return "answer";
          }),
      },
    });
  });

describe("allowedNext", () => {
  it("offers an Answerer its reply, with the open poll's id filled in", () => {
    const next = allowedNext(PROTOCOL, [ASK], "bea");

    expect(names(next)).toEqual(["reply"]);
    expect(next[0]?.declaration).toMatch(
      new RegExp(`:meeting\\s+${POLL}$`, "mu"),
    );
  });

  it("offers the Asker nothing until every member has replied", () => {
    expect(allowedNext(PROTOCOL, [ASK, reply("bea", "[1]")], "asker")).toEqual(
      [],
    );
    expect(
      names(
        allowedNext(
          PROTOCOL,
          [ASK, reply("bea", "[1]"), reply("cal", "[1 | 2]")],
          "asker",
        ),
      ),
    ).toEqual(["decide"]);
  });
});

describe("makeProtocolPipeline", () => {
  it.effect(
    "answers an English reply from what the sender can see and may send",
    () =>
      Effect.gen(function* () {
        const responses: ResponderInput[] = [];
        const daemon = yield* pipeline(responses);

        const outcome = yield* daemon.judge([ASK, reply("cal", "[2]")], {
          sender: "bea",
          recipients: ["asker"],
          text: "Monday works for me.",
        });

        expect(outcome).toEqual({
          kind: "refused",
          reasons: ["not exactly one act"],
          answer: "answer",
        });
        expect(responses[0]?.conversation).toEqual([ASK]);
        expect(names(responses[0]?.allowed ?? [])).toEqual(["reply"]);
      }),
  );

  it.effect("refuses a list of numbers written without separators", () =>
    Effect.gen(function* () {
      const daemon = yield* pipeline([]);

      const outcome = yield* daemon.judge([ASK], reply("bea", "[1 2]"));

      expect(outcome.kind === "refused" && outcome.reasons).toEqual([
        ":free names an item not in the latest ask",
      ]);
    }),
  );

  it.effect("attaches each recipient's next acts to a message it sends", () =>
    Effect.gen(function* () {
      const daemon = yield* pipeline([]);

      const outcome = yield* daemon.judge([], ASK);

      expect(outcome.kind === "pass" && guided(outcome.guidance)).toEqual([
        ["bea", ["reply"]],
        ["cal", ["reply"]],
      ]);
    }),
  );
});
