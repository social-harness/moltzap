/** @file Pins which received request an answer sent to a conversation answers, by the id it names or as the one open there. */

import { Either, FastCheck as fc, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CollectiveId } from "./forms.js";
import { AgentAddress, MessageAddressInput } from "../records/values.js";
import { collectiveIdOf } from "./part/index.js";
import { matchOpenRequest, type RequestStatus } from "./received-request.js";

const NOW = 1_000_000;
const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const bobConversation =
  Schema.decodeUnknownSync(MessageAddressInput)("agent:bob");
const groupConversation = Schema.decodeUnknownSync(MessageAddressInput)(
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
    onLeft: ({ kind }) => kind,
    onRight: () => "matched",
  });

/** The id `requestsOf` gives the held request at `index`. */
const idAt = (index: number) =>
  collectiveIdOf(bob, String(index).padStart(43, "n"));

/** Held requests, the index of the one an answer to agent:bob names, and the refusal it gets. */
const NAMED_REFUSALS: ReadonlyArray<[readonly HeldRequest[], number, string]> =
  [
    [[{ inBob: false, state: "open", expired: false }], 0, "request-none"],
    [[{ inBob: true, state: "open", expired: false }], 1, "request-none"],
    [[{ inBob: true, state: "answered", expired: false }], 0, "request-answered"],
    [[{ inBob: true, state: "open", expired: true }], 0, "request-expired"],
    [[{ inBob: true, state: "closed", expired: false }], 0, "request-expired"],
  ];

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
  it(
    "lists every open request's id when an answer names none and several are open",
    listsOpenIdsWhenAmbiguous,
  );
});

describe("matching an answer to the request it names", () => {
  it(
    "answers each of two open requests in one conversation by its id",
    answersEachOpenRequestById,
  );
  it.each<[readonly HeldRequest[], number, string]>(NAMED_REFUSALS)(
    "refuses an answer over %j naming request %i as %s",
    (held, index, expected) => {
      expect(
        matchOpenRequest(requestsOf(held), bobConversation, NOW, idAt(index)),
      ).toEqual(Either.left({ kind: expected }));
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

function listsOpenIdsWhenAmbiguous() {
  const requests = requestsOf([
    { inBob: true, state: "open", expired: false },
    { inBob: true, state: "answered", expired: false },
    { inBob: true, state: "open", expired: false },
  ]);

  expect(matchOpenRequest(requests, bobConversation, NOW)).toEqual(
    Either.left({ kind: "request-ambiguous", openIds: [idAt(0), idAt(2)] }),
  );
}

function answersEachOpenRequestById() {
  const requests = requestsOf([
    { inBob: true, state: "open", expired: false },
    { inBob: true, state: "open", expired: false },
  ]);

  expect(matchOpenRequest(requests, bobConversation, NOW, idAt(0))).toEqual(
    Either.right({ id: idAt(0), request: requests.get(idAt(0)) }),
  );
  expect(matchOpenRequest(requests, bobConversation, NOW, idAt(1))).toEqual(
    Either.right({ id: idAt(1), request: requests.get(idAt(1)) }),
  );
}
