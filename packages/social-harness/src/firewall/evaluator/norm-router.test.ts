/**
 * @file Routing among the holder's norms: `get-norm` is answered in code, a
 * message goes to the norm whose acts it uses or whose request is open, and
 * only otherwise to the selector, whose "none" leaves the message unchecked.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Post } from "./protocol-pipeline.js";
import {
  getNormRequest,
  type HeldNorm,
  makeNormRouter,
  pointerResponder,
  type Selector,
} from "./norm-router.js";

const POLL = `protocol poll

meetings
  ask opens a poll. The Asker gives it an id in :meeting that the conversation has not used before.

acts sent by the Asker

  (ask
    :meeting      a new poll id
    :members      a list of every Answerer)
  when opens

  (close
    :meeting      the open poll's id)
  when answers; final

acts sent by the Answerer

  (reply
    :meeting      the open poll's id
    :free         a list of numbers)
  when answers; sent by a member
`;

const DESK = `protocol desk

requests
  ticket opens a request. The Visitor gives it an id in :request that this conversation has not used before.

acts sent by the Visitor

  (ticket
    :request      a new request id
    :topic        what the visitor needs)
  when opens
`;

const ASK: Post = {
  sender: "asker",
  recipients: ["bea"],
  text: "(ask\n  :meeting p1\n  :members [agent:bea])",
};
const ENGLISH: Post = {
  sender: "bea",
  recipients: ["asker"],
  text: "Monday works for me.",
};

/** A held norm whose pipeline records the messages it is given and refuses them. */
function held(name: string, protocol: string, seen: string[]): HeldNorm {
  return {
    name,
    description: `the ${name} norm`,
    text: `the whole ${name} norm`,
    protocol,
    judge: (...[, message]) =>
      Effect.sync(() => {
        seen.push(`${name}: ${message.text}`);
        return { kind: "refused", reasons: [], answer: "" } as const;
      }),
  };
}

/** A selector that always picks `choice`, or no norm, and records that it was asked. */
function picking(asked: string[], choice?: string): Selector {
  return {
    select: ({ message }) =>
      Effect.sync(() => {
        asked.push(message.text);
        return choice;
      }),
  };
}

const REASON = "not exactly one act";

describe("get-norm", () => {
  it.effect("is answered with the named norm's text, in code", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const desk = held("desk", DESK, seen);
      const router = makeNormRouter({
        norms: [held("poll", POLL, seen), desk],
        selector: picking([]),
      });

      const routed = yield* router.judge([], {
        ...ENGLISH,
        text: getNormRequest(desk.name),
      });

      expect(routed).toEqual({ kind: "norm-text", answer: desk.text });
      expect(seen).toEqual([]);
    }),
  );

  it.effect("lists the held norms when it names none of them", () =>
    Effect.gen(function* () {
      const poll = held("poll", POLL, []);
      const router = makeNormRouter({ norms: [poll], selector: picking([]) });

      const routed = yield* router.judge([], {
        ...ENGLISH,
        text: "(get-norm)",
      });

      expect(routed.kind === "norm-text" && routed.answer).toContain(
        poll.description,
      );
    }),
  );
});

describe("a message a norm's acts or state settle", () => {
  it.effect("goes to the norm with an open request, unasked", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const router = makeNormRouter({
        norms: [held("poll", POLL, []), held("desk", DESK, [])],
        selector: picking(asked, "desk"),
      });

      const routed = yield* router.judge([ASK], ENGLISH);

      expect(routed).toMatchObject({ kind: "refused", norm: "poll" });
      expect(asked).toEqual([]);
    }),
  );

  it.effect("goes to the norm that declares its act", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const router = makeNormRouter({
        norms: [held("poll", POLL, seen), held("desk", DESK, seen)],
        selector: picking([], "poll"),
      });
      const ticket = "(ticket\n  :request r1\n  :topic printer)";

      yield* router.judge([ASK], { ...ENGLISH, text: ticket });

      expect(seen).toEqual([`desk: ${ticket}`]);
    }),
  );
});

describe("a message neither acts nor state settle", () => {
  it.effect("goes to the norm the selector picks", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const router = makeNormRouter({
        norms: [held("poll", POLL, []), held("desk", DESK, [])],
        selector: picking(asked, "desk"),
      });

      const routed = yield* router.judge([], ENGLISH);

      expect(routed).toMatchObject({ kind: "refused", norm: "desk" });
      expect(asked).toEqual([ENGLISH.text]);
    }),
  );

  it.effect("passes unchecked when the selector picks none", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const router = makeNormRouter({
        norms: [held("poll", POLL, seen)],
        selector: picking([]),
      });

      const routed = yield* router.judge([], ENGLISH);

      expect(routed).toEqual({ kind: "ungoverned" });
      expect(seen).toEqual([]);
    }),
  );
});

describe("pointerResponder", () => {
  it("names the norm, the reasons and the get-norm act", () => {
    const answer = Effect.runSync(
      pointerResponder("poll").respond({
        protocol: POLL,
        conversation: [ASK],
        message: ENGLISH,
        reasons: [REASON],
        allowed: [],
      }),
    );

    expect(answer).toContain(getNormRequest("poll"));
    expect(answer).toContain(REASON);
  });
});
