/** @file The inbox and operation MCP representation: exact requests, and results a newer daemon can extend. */

import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../communication/conversations/message.js";
import { testAgentView } from "../__tests__/agent-card-fixtures.js";
import {
  CollectiveError,
  CollectiveId,
  SendInput,
} from "../communication/collectives/contracts.js";
import { Content, PostId } from "../communication/records/index.js";
import { AgentAddress, GroupAddress } from "../communication/records/values.js";
import { DeliveryToken } from "../communication/store/index.js";
import { exactParseOptions } from "../encoding/exact.js";
import {
  decodeHarnessAcknowledgeDeliveryRequest,
  decodeHarnessMessageReadyEvent,
  decodeHarnessReadInboxResult,
  decodeHarnessSendErrorData,
  decodeHarnessSendResult,
  sendErrorData,
} from "./operations.js";

const deliveryToken = Schema.decodeUnknownSync(DeliveryToken)(
  `dlv_${"A".repeat(43)}`,
);
const peerAddress = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const senderAddress = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const thirdAddress = Schema.decodeUnknownSync(AgentAddress)("agent:carol");
const outsiderAddress = Schema.decodeUnknownSync(AgentAddress)("agent:dave");
const groupAddress = Schema.decodeUnknownSync(GroupAddress)(
  "group:alice,bob,carol",
);
const postId = Schema.decodeUnknownSync(PostId)(`pst_${"A".repeat(43)}`);
const content = Schema.decodeUnknownSync(Content)([
  { type: "text", text: "meeting invite sent" },
]);

const collectiveId = Schema.decodeUnknownSync(CollectiveId)(
  `col_${"A".repeat(43)}`,
);
const openIds = [
  Schema.decodeUnknownSync(CollectiveId)(`col_${"B".repeat(42)}A`),
  Schema.decodeUnknownSync(CollectiveId)(`col_${"C".repeat(42)}A`),
];

function decodesExactOperationRequests(): void {
  const operation = {
    to: peerAddress,
    text: "meeting invite sent",
    collective: { op: "multicast" },
  };

  expect(
    Effect.runSync(
      Schema.decodeUnknown(SendInput)(operation, exactParseOptions),
    ),
  ).toEqual(operation);
  expect(
    Effect.runSync(decodeHarnessAcknowledgeDeliveryRequest({ deliveryToken })),
  ).toEqual({ deliveryToken });
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodeHarnessAcknowledgeDeliveryRequest({ deliveryToken, content }),
      ),
    ),
    "acknowledgment carrying content",
  ).toBe(true);
}

function decodesCanonicalDirectDelivery(): void {
  const message: InboundMessage = {
    kind: "direct",
    postId,
    address: senderAddress,
    sender: testAgentView(senderAddress),
    content,
  };

  const item = { kind: "multicast", message };

  expect(
    Effect.runSync(decodeHarnessMessageReadyEvent({ deliveryToken, item })),
  ).toEqual({ deliveryToken, item });
  expect(
    Effect.runSync(
      decodeHarnessMessageReadyEvent({
        deliveryToken,
        item,
        replyGrant: "forbidden",
      }),
    ),
    "a field the event does not name is dropped",
  ).toEqual({ deliveryToken, item });
}

function unreachableFailure(reason: string) {
  return {
    reason: "collective-failed",
    id: collectiveId,
    failure: {
      kind: "members-unreachable",
      members: [{ member: peerAddress, reason }],
    },
  };
}

function rejectsAnUntaggedMessage(): void {
  const message: InboundMessage = {
    kind: "direct",
    postId,
    address: senderAddress,
    sender: testAgentView(senderAddress),
    content,
  };

  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodeHarnessMessageReadyEvent({ deliveryToken, message }),
      ),
    ),
    "delivery carrying a bare message",
  ).toBe(true);
}

function decodesCanonicalGroupDelivery(): void {
  const message: InboundMessage = {
    kind: "group",
    postId,
    address: groupAddress,
    sender: testAgentView(peerAddress),
    members: [
      testAgentView(senderAddress),
      testAgentView(peerAddress),
      testAgentView(thirdAddress),
    ],
    content,
  };
  const item = { kind: "multicast", message };

  expect(
    Effect.runSync(decodeHarnessMessageReadyEvent({ deliveryToken, item })),
  ).toEqual({ deliveryToken, item });
}

const inconsistentDeliveries = [
  {
    case: "a sender whose principal differs from its member identity",
    message: {
      kind: "group",
      postId,
      address: groupAddress,
      sender: {
        ...testAgentView(peerAddress),
        principalId: testAgentView(senderAddress).principalId,
      },
      members: [
        testAgentView(senderAddress),
        testAgentView(peerAddress),
        testAgentView(thirdAddress),
      ],
      content,
    },
  },
  {
    case: "one agent id repeated under different member names",
    message: {
      kind: "group",
      postId,
      address: groupAddress,
      sender: testAgentView(peerAddress),
      members: [
        testAgentView(senderAddress),
        testAgentView(peerAddress),
        {
          ...testAgentView(thirdAddress),
          agentId: testAgentView(senderAddress).agentId,
        },
      ],
      content,
    },
  },
  {
    case: "a direct address that is not the sender",
    message: {
      kind: "direct",
      postId,
      address: peerAddress,
      sender: testAgentView(senderAddress),
      content,
    },
  },
  {
    case: "group members out of canonical order",
    message: {
      kind: "group",
      postId,
      address: groupAddress,
      sender: testAgentView(peerAddress),
      members: [peerAddress, senderAddress, thirdAddress].map(testAgentView),
      content,
    },
  },
  {
    case: "a repeated group member",
    message: {
      kind: "group",
      postId,
      address: groupAddress,
      sender: testAgentView(peerAddress),
      members: [senderAddress, peerAddress, peerAddress].map(testAgentView),
      content,
    },
  },
  {
    case: "a sender outside the group",
    message: {
      kind: "group",
      postId,
      address: groupAddress,
      sender: testAgentView(outsiderAddress),
      members: [
        testAgentView(senderAddress),
        testAgentView(peerAddress),
        testAgentView(thirdAddress),
      ],
      content,
    },
  },
];

// @agent-code-guard/regression-only: these examples pin the exact public wire grammar and its relational identity checks.
describe("Harness MCP operation representation", () => {
  it("decodes exact send and acknowledgment requests", () => {
    decodesExactOperationRequests();
  });
  it("decodes one canonical direct multicast delivery", () => {
    decodesCanonicalDirectDelivery();
  });
  it("rejects a delivery that carries a message without an item", () => {
    rejectsAnUntaggedMessage();
  });
  it("decodes one canonical group multicast delivery", () => {
    decodesCanonicalGroupDelivery();
  });
  it.each(inconsistentDeliveries)(
    "rejects a delivery with $case",
    ({ message }) => {
      expect(
        Exit.isFailure(
          Effect.runSyncExit(
            decodeHarnessMessageReadyEvent({
              deliveryToken,
              item: { kind: "multicast", message },
            }),
          ),
        ),
      ).toBe(true);
    },
  );
  /** A collective refusal keeps the closed send-failure vocabulary for each member. */
  it.each(["unknown-agent", "network-unavailable"])(
    "decodes an unreachable member with send failure reason %s",
    (reason) => {
      expect(
        Effect.runSync(decodeHarnessSendErrorData(unreachableFailure(reason))),
      ).toEqual(unreachableFailure(reason));
    },
  );
  it("rejects an unreachable member whose reason is not a send failure", () => {
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          decodeHarnessSendErrorData(unreachableFailure("transport-failed")),
        ),
      ),
    ).toBe(true);
  });
});

// @agent-code-guard/regression-only: validation diagnostics must preserve refusals without admitting raw decoder data.
describe("Harness send validation diagnostics", () => {
  it.each([
    { reason: "content-invalid" },
    {
      reason: "content-invalid",
      issues: [
        { path: [], message: "Expected object" },
        { path: ["input", "choices", 0], message: "Expected string" },
      ],
    },
  ])(
    "preserves a content refusal with optional field diagnostics: %j",
    (data) => {
      expect(Effect.runSync(decodeHarnessSendErrorData(data))).toEqual(data);
    },
  );
  it.each([
    { path: [false], message: "Expected string" },
    { path: ["input"], message: 123 },
  ])("keeps the refusal but not malformed diagnostics: %j", (issue) => {
    expect(
      Effect.runSync(
        decodeHarnessSendErrorData({
          reason: "content-invalid",
          issues: [issue],
        }),
      ),
    ).toEqual({ reason: "content-invalid" });
  });
  it("drops raw decoder data from a diagnostic", () => {
    expect(
      Effect.runSync(
        decodeHarnessSendErrorData({
          reason: "content-invalid",
          issues: [
            { path: ["input"], message: "Expected string", rawDecoder: {} },
          ],
        }),
      ),
    ).toEqual({
      reason: "content-invalid",
      issues: [{ path: ["input"], message: "Expected string" }],
    });
  });
});

describe("Harness send refusal data", () => {
  it.each([
    { reason: "firewall-refused", checkId: "chk_x" },
    { reason: "collective-failed" },
    {
      reason: "collective-failed",
      id: collectiveId,
      failure: { kind: "request-ambiguous" },
    },
  ])(
    "refuses a firewall or collective refusal missing its fields: %j",
    (data) => {
      expect(
        Exit.isFailure(Effect.runSyncExit(decodeHarnessSendErrorData(data))),
      ).toBe(true);
    },
  );
  it.each([{ ids: [] }, { ids: [collectiveId] }])(
    "refuses an ambiguous answer with fewer than two open ids: $ids",
    ({ ids }) => {
      expect(
        Exit.isFailure(
          Effect.runSyncExit(
            decodeHarnessSendErrorData({
              reason: "collective-failed",
              id: collectiveId,
              failure: { kind: "request-ambiguous", openIds: ids },
            }),
          ),
        ),
      ).toBe(true);
    },
  );
  it("carries the open ids of an answer that named none of several open requests", () => {
    const refused = new CollectiveError({
      id: collectiveId,
      failure: { kind: "request-ambiguous", openIds },
    });
    const data = sendErrorData(refused);

    expect(data).toEqual({
      reason: "collective-failed",
      id: collectiveId,
      failure: { kind: "request-ambiguous", openIds },
    });
    expect(Effect.runSync(decodeHarnessSendErrorData(data))).toEqual(data);
  });
});

const directItem = {
  kind: "multicast",
  message: {
    kind: "direct",
    postId,
    address: senderAddress,
    sender: testAgentView(senderAddress),
    content,
  },
};

const fails = (effect: Effect.Effect<unknown, unknown>): boolean =>
  Exit.isFailure(Effect.runSyncExit(effect));

describe("Harness MCP results from a newer daemon", () => {
  it("decodes a send result that carries a field this release does not name", () => {
    expect(
      Effect.runSync(
        decodeHarnessSendResult({
          kind: "collective",
          operationId: collectiveId,
          addedLater: true,
        }),
      ),
    ).toEqual({ kind: "collective", operationId: collectiveId });
  });
  it("decodes an inbox page whose page and entries carry added fields", () => {
    expect(
      Effect.runSync(
        decodeHarnessReadInboxResult({
          items: [{ deliveryToken, item: directItem, addedLater: 1 }],
          nextCursor: "c1",
          addedLater: "x",
        }),
      ),
    ).toEqual({
      items: [{ deliveryToken, item: directItem }],
      nextCursor: "c1",
    });
  });
  it("decodes a send refusal whose data carries an added field", () => {
    expect(
      Effect.runSync(
        decodeHarnessSendErrorData({
          reason: "network-unavailable",
          detail: "router closed",
          addedLater: true,
        }),
      ),
    ).toEqual({ reason: "network-unavailable", detail: "router closed" });
  });
});

describe("Harness MCP results keep what they name", () => {
  it.each([
    { case: "an inbox page without items", value: { nextCursor: "c1" } },
    {
      case: "an inbox entry without its delivery token",
      value: { items: [{ item: directItem }] },
    },
  ])("still refuses $case", ({ value }) => {
    expect(fails(decodeHarnessReadInboxResult(value))).toBe(true);
  });
  it("still refuses guidance that mixes or extends its forms", () => {
    const checkId = `chk_${"a".repeat(64)}`;
    expect(
      fails(
        decodeHarnessSendResult({
          kind: "collective",
          operationId: collectiveId,
          guidance: {
            checkId,
            subjects: [],
            instructions: [
              {
                middlewareId: "m",
                ruleId: "r",
                instruction: "wait for the owner",
                expectation: "invalid",
                subjects: [],
                uncertain: { choice: "approved", probability: 0.5 },
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });
  it("still refuses a pending-delivery event without its item", () => {
    expect(fails(decodeHarnessMessageReadyEvent({ deliveryToken }))).toBe(true);
  });
});
