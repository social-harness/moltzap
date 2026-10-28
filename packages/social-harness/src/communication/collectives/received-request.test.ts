/** @file Pins which received request an answer sent to a conversation answers. */

import { Either, FastCheck as fc, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CollectiveId } from "./forms.js";
import { AgentAddress, GroupAddress } from "../records/values.js";
import { collectiveIdOf } from "./part/index.js";
import { matchOpenRequest, type RequestStatus } from "./received-request.js";

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
      collectiveIdOf(bob, String(index).padStart(43, "n")),
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
  Either.match(matchOpenRequest(requestsOf(held), bobConversation, NOW), {
    onLeft: (kind) => kind,
    onRight: () => "matched",
  });

/** Held requests and the refusal each set gives an answer to agent:bob. */
const REFUSALS: ReadonlyArray<[readonly HeldRequest[], string]> = [
  [[], "request-none"],
  [[{ inBob: false, state: "open", expired: false }], "request-none"],
  [
    [
      { inBob: true, state: "open", expired: false },
      { inBob: true, state: "open", expired: false },
    ],
    "request-ambiguous",
  ],
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
  it("returns the open request's id and request", returnsTheOpenRequest);
  it.each<[readonly HeldRequest[], string]>(REFUSALS)(
    "refuses %j as %s",
    (held, expected) => {
      expect(kindOf(held)).toBe(expected);
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

  expect(matchOpenRequest(requests, bobConversation, NOW)).toEqual(
    Either.right({ id: open?.[0], request: open?.[1] }),
  );
}
