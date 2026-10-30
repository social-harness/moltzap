/** @file Exact wire grammar of the daemon management address schemas. */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  managementSearchConversationsRequestSchema,
  managementSearchConversationsResultSchema,
} from "./daemon-tools.js";

const conversationId = digest("cnv_", 1);

// @agent-code-guard/regression-only: the wire schema accepts only address cursors and canonical pages.
describe("management address schemas", () => {
  it("accepts canonical address cursors and rejects excess fields", () => {
    expect(
      Schema.decodeUnknownSync(managementSearchConversationsRequestSchema)({
        afterAddress: "agent:bob",
      }),
    ).toEqual({ afterAddress: "agent:bob" });
    expect(() =>
      Schema.decodeUnknownSync(managementSearchConversationsRequestSchema)({
        afterConversationId: conversationId,
      }),
    ).toThrow();
  });

  it("requires strictly ordered address pages", () => {
    expect(
      Schema.decodeUnknownSync(managementSearchConversationsResultSchema)({
        kind: "page",
        addresses: ["agent:bob", "group:alice,bob,carol"],
        hasMore: false,
      }),
    ).toEqual({
      kind: "page",
      addresses: ["agent:bob", "group:alice,bob,carol"],
      hasMore: false,
    });
    expect(() =>
      Schema.decodeUnknownSync(managementSearchConversationsResultSchema)({
        kind: "page",
        addresses: ["group:alice,bob,carol", "agent:bob"],
        hasMore: false,
      }),
    ).toThrow();
  });
});
