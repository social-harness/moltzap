/** @file Pins which received request an answer sent to a conversation answers, by the operationId it names or as the one open there. */

import { Either, FastCheck as fc, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CollectiveId } from "./contracts.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import { AgentAddress, GroupAddress } from "../records/values.js";
import {
  matchOpenRequest,
  type RequestStatus,
  unmatchedAnswerError,
} from "./received-request.js";

const NOW = 1_000_000;
const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const bobConversation = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const groupConversation = Schema.decodeUnknownSync(GroupAddress)(
  "group:alice,bob,carol",
);

type RequestState = RequestStatus["state"];

/** One held request: its conversation, state, and whether its deadline passed. */
interface HeldRequest {
  readonly inBob: boolean;
  readonly state: RequestState;
  readonly expired: boolean;
}

const heldRequest: fc.Arbitrary<HeldRequest> = fc.record({
  inBob: fc.boolean(),
  state: fc.constantFrom<RequestState>("open", "sending", "answered", "closed"),
  expired: fc.boolean(),
});

const requestsOf = (held: readonly HeldRequest[]) =>
  new Map<CollectiveId, RequestStatus>(
    held.map(({ inBob, state, expired }, index) => [
      collectiveOperationId(testAgentView(bob).agentId, index),
      {
        to: inBob ? bobConversation : groupConversation,
        deadlineAt: expired ? NOW : NOW + 1,
        state,
      },
    ]),
  );

const isOpen = ({ inBob, state, expired }: HeldRequest) =>
  inBob && state === "open" && !expired;

/** The refusal kind an answer to agent:bob gets over `held`, or `matched`. */
const kindOf = (held: readonly HeldRequest[]) =>
  Either.match(matchOpenRequest(requestsOf(held), bobConversation, NOW, {}), {
    onLeft: ({ kind }) => kind,
    onRight: () => "matched",
  });

/** The operationId `requestsOf` gives the held request at `index`. */
const idAt = (index: number) =>
  collectiveOperationId(testAgentView(bob).agentId, index);

/** Each named refusal keeps only a request selected in the target conversation. */
const NAMED_REFUSALS = [
  {
    held: [{ inBob: false, state: "open", expired: false }],
    named: 0,
    expected: {
      kind: "request-none",
      openElsewhere: [{ operationId: idAt(0), to: groupConversation }],
    },
  },
  {
    held: [{ inBob: true, state: "open", expired: false }],
    named: 1,
    expected: { kind: "request-none", openElsewhere: [] },
  },
  {
    held: [{ inBob: true, state: "answered", expired: false }],
    named: 0,
    expected: {
      kind: "request-answered",
      operationId: idAt(0),
      openElsewhere: [],
    },
  },
  {
    held: [{ inBob: true, state: "open", expired: true }],
    named: 0,
    expected: {
      kind: "request-expired",
      operationId: idAt(0),
      openElsewhere: [],
    },
  },
] as const;

/** Held requests and the refusal each set gives an answer to agent:bob. */
const REFUSALS: ReadonlyArray<[readonly HeldRequest[], string]> = [
  [[], "request-none"],
  [
    [
      { inBob: true, state: "answered", expired: false },
      { inBob: true, state: "open", expired: true },
    ],
    "request-answered",
  ],
  [
    [
      { inBob: true, state: "open", expired: true },
      { inBob: true, state: "closed", expired: false },
    ],
    "request-expired",
  ],
];

describe("matching an answer to its conversation's open request", () => {
  it(
    "matches exactly when one request in the conversation is open",
    matchesExactlyOneOpenRequest,
  );
  it("ignores requests held in other conversations", ignoresOtherConversations);
  it(
    "returns the open request's operationId and request",
    returnsTheOpenRequest,
  );
  it("names only this conversation's open requests in an ambiguous failure", () => {
    const requests = requestsOf([
      { inBob: true, state: "open", expired: false },
      { inBob: false, state: "open", expired: false },
      { inBob: true, state: "open", expired: true },
      { inBob: true, state: "open", expired: false },
    ]);
    const refusal = Either.match(
      matchOpenRequest(requests, bobConversation, NOW, {}),
      {
        onLeft: (unmatched) => unmatchedAnswerError(unmatched),
        onRight: () => undefined,
      },
    );

    expect(refusal).toMatchObject({
      failure: {
        kind: "request-ambiguous",
        openOperationIds: [idAt(0), idAt(3)],
      },
    });
    expect(refusal?.operationId).toBeUndefined();
  });
  it.each<[readonly HeldRequest[], string]>(REFUSALS)(
    "refuses %j as %s",
    (held, expected) => {
      const result = matchOpenRequest(
        requestsOf(held),
        bobConversation,
        NOW,
        {},
      );
      expect(result).toEqual(
        Either.left({ kind: expected, openElsewhere: [] }),
      );
    },
  );
});

describe("matching an answer to the request it names", () => {
  it.each(NAMED_REFUSALS)(
    "refuses request $named over $held as $expected.kind",
    ({ held, named, expected }) => {
      expect(
        matchOpenRequest(requestsOf(held), bobConversation, NOW, {
          operationId: idAt(named),
        }),
      ).toEqual(Either.left(expected));
    },
  );
});

function matchesExactlyOneOpenRequest() {
  fc.assert(
    fc.property(fc.array(heldRequest, { maxLength: 6 }), (held) => {
      const openCount = held.filter(isOpen).length;
      const kind = kindOf(held);

      expect(kind === "matched").toBe(openCount === 1);
      expect(kind === "request-ambiguous").toBe(openCount > 1);
    }),
  );
}

function ignoresOtherConversations() {
  fc.assert(
    fc.property(
      fc.array(heldRequest, { maxLength: 6 }),
      fc.array(heldRequest, { maxLength: 6 }),
      (held, elsewhere) => {
        const moved = elsewhere.map((other) => ({ ...other, inBob: false }));

        expect(kindOf([...held, ...moved])).toBe(kindOf(held));
      },
    ),
  );
}

function returnsTheOpenRequest() {
  const requests = requestsOf([
    { inBob: true, state: "answered", expired: false },
    { inBob: true, state: "open", expired: false },
  ]);
  const [, open] = [...requests];

  expect(matchOpenRequest(requests, bobConversation, NOW, {})).toEqual(
    Either.right({ operationId: open?.[0], request: open?.[1] }),
  );
}

it.each(["answered", "closed", "open"] as const)(
  "identifies the one unavailable request when its state is %s",
  (state) => {
    const requests = requestsOf([{ inBob: true, state, expired: true }]);
    const expected =
      state === "answered" ? "request-answered" : "request-expired";
    expect(matchOpenRequest(requests, bobConversation, NOW, {})).toEqual(
      Either.left({ kind: expected, operationId: idAt(0), openElsewhere: [] }),
    );
  },
);
